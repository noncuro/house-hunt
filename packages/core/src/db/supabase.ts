/** Every database read and write in the extension.
 *
 *  The client itself lives in `lib/auth.ts`, which is the only file that constructs one; this file
 *  is the queries. Both are imported for their runtime values by `entrypoints/background.ts` and by
 *  nothing else — a view that imported either would put a second Supabase client in a second
 *  context, and two contexts refreshing one rotating refresh token is how a session gets silently
 *  invalidated. `tools/check-one-client.ts` enforces it (design D2).
 *
 *  Two rules run through everything below, both from design D4:
 *
 *  * **Every project-scoped query names the active project.** RLS would filter them anyway, but a
 *    query that relies on RLS to scope it reads as a query with a bug, and the day somebody adds a
 *    table without a policy it becomes one.
 *  * **No client writes a shared fact table.** `property`, `property_analysis`, `station_point`,
 *    `station_walk` and `travel_time` are SELECT-only for `authenticated`; the writes go through
 *    `SECURITY DEFINER` RPCs that validate their arguments. This file already funnelled those
 *    writes through a handful of named functions, so what changed is what they call.
 */
import { db, ensureSession } from './client';
import { accessToken, requireSession } from './session';
import { MIN_PASSWORD_LENGTH } from '../contracts';
import { rightmoveListingId } from '../listing';
import type {
  AddListingResult,
  AdminProject,
  AdminUser,
  AuthState,
  Headcount,
  Invite,
  InviteResult,
  LocationResult,
  ProjectMember,
  ProjectSummary,
  RedeemResult,
  SessionUser,
  SpendSummary,
  UsageRow,
} from '../contracts';
import type { HuntPreferences } from '../facts';
// Postcode resolution goes through the travel Edge Function, not postcodes.io directly: the
// website's CSP allows `connect-src` to Supabase alone, so a browser fetch to postcodes.io is
// refused at the preflight. `locatePostcode`/`locatePostcodes` are the function-routed path that
// works on both surfaces. (The Edge Function still calls `../postcode` itself, server-side.)
import { locatePostcode, locatePostcodes } from './travel';
import { MODEL_VERSION, type LabelMode, type Model, type ModelMetrics } from '../predict';
import type { PricePoint } from '../recheck';
import type { SearchCard } from '../search-card';
import { sweepProgress } from '../sweep';
import { type StationInfo } from '../tfl';
import type { ArchiveReason, PropertyStage, Stage } from '../stage';
import { toSleepingSeparation } from '../types';
import type {
  Analysis,
  Confidence,
  JourneyOption,
  Listing,
  Place,
  Rating,
  Station,
  TravelMode,
  Verdict,
} from '../types';

function fail(context: string, error: { message: string } | null): void {
  if (error) throw new Error(`${context}: ${error.message}`);
}

/** Signed in, but with no project to read. Distinct from being signed out, and rendered
 *  differently: the shortlist shows the project picker rather than the sign-in view (design D13). */
export class NoActiveProject extends Error {
  constructor(message = 'no active project') {
    super(message);
    this.name = 'NoActiveProject';
  }
}

// PostgREST rows are untyped JSON — we have no generated database types, so `any` at this one
// boundary is the honest description, and every field is renamed and narrowed on the way out.
// oxlint-disable no-explicit-any

// ------------------------------------------------------------------------------------------------
// Who is signed in, and which project they are working in.
// ------------------------------------------------------------------------------------------------

/** The active project, resolved once per worker lifetime.
 *
 *  Cached against the user id rather than globally: signing out and back in as somebody else in the
 *  same worker must not leave the previous person's project in place, and that is exactly what a
 *  bare module-level string would do. */
let projectCache: { userId: string; projectId: string } | null = null;

export function forgetActiveProject(): void {
  projectCache = null;
}

interface ProfileRow {
  id: string;
  email: string;
  display_name: string | null;
  is_admin: boolean;
  active_project_id: string | null;
  monthly_cap_usd: number;
}

async function readProfile(userId: string, fallbackEmail: string): Promise<SessionUser & { activeProjectId: string | null }> {
  const { data, error } = await db()
    .from('profile')
    .select('id, email, display_name, is_admin, active_project_id, monthly_cap_usd')
    .eq('id', userId)
    .maybeSingle();
  fail('reading your profile', error);
  // The profile is created by a trigger on auth.users, so its absence means the trigger did not
  // run — a broken install rather than a new user, and saying so beats rendering a blank shell.
  if (!data) throw new Error('signed in, but no profile row exists for this account');
  const row = data as ProfileRow;
  return {
    id: row.id,
    email: row.email || fallbackEmail,
    displayName: row.display_name?.trim() || row.email || fallbackEmail,
    isAdmin: row.is_admin,
    monthlyCapUsd: Number(row.monthly_cap_usd),
    activeProjectId: row.active_project_id,
  };
}

async function readMemberships(): Promise<ProjectSummary[]> {
  // Filtered by user here, not left to RLS. `read_project_member` is `is_member(project_id) OR
  // is_admin()`, so for an admin this returns *everybody's* memberships — and the picker then
  // lists hunts they are not in, each with an Open button. Switching to one succeeds, because the
  // write is to the admin's own profile row, and every scoped query afterwards is denied; that
  // surfaces as an empty shortlist rather than as an error. RLS is the ceiling on what a query is
  // allowed to return, never the definition of what this one means.
  const session = await requireSession();
  const { data, error } = await db()
    .from('project_member')
    .select('role, project:project_id (id, name, monthly_cap_usd, max_members)')
    .eq('user_id', session.user.id)
    .order('joined_at');
  fail('reading your projects', error);
  return (data ?? []).flatMap((row: any) => {
    const project = Array.isArray(row.project) ? row.project[0] : row.project;
    if (!project) return [];
    return [
      {
        id: project.id,
        name: project.name,
        role: row.role as 'member' | 'owner',
        monthlyCapUsd: Number(project.monthly_cap_usd),
        maxMembers: project.max_members,
      },
    ];
  });
}

/** The whole signed-in picture in one answer: who you are, what you are in, and what is active.
 *
 *  It also repairs the one state that renders as a broken extension rather than as a question:
 *  a user with memberships and no active project. Choosing their only project for them is not a
 *  decision anybody would make differently, and leaving it null means an empty shortlist. With
 *  more than one, the picker asks. */
export async function authState(): Promise<AuthState> {
  const session = await requireSession();
  const profile = await readProfile(session.user.id, session.user.email ?? '');
  const projects = await readMemberships();

  let activeId = profile.activeProjectId;
  if (activeId && !projects.some((p) => p.id === activeId)) activeId = null;
  if (!activeId && projects.length === 1) {
    await setActiveProject(projects[0]!.id);
    activeId = projects[0]!.id;
  }
  projectCache = activeId ? { userId: session.user.id, projectId: activeId } : null;

  void touchLastSeen(session.user.id);

  return {
    status: 'signed-in',
    user: {
      id: profile.id,
      email: profile.email,
      displayName: profile.displayName,
      isAdmin: profile.isAdmin,
      monthlyCapUsd: profile.monthlyCapUsd,
    },
    projects,
    activeProject: projects.find((p) => p.id === activeId) ?? null,
  };
}

/** The one read that answers rather than refusing when there is no session.
 *
 *  Every surface asks this first to decide what to render, so it must be able to say "signed out"
 *  as a value. `authState` throws `Unauthenticated` instead, which is right for the forty reads that
 *  cannot proceed without a user and exactly wrong for the one that decides whether to show the
 *  sign-in view: answering the shell with an exception makes signing in unreachable. */
export async function readAuthState(): Promise<AuthState> {
  const session = await ensureSession();
  if (!session) return { status: 'signed-out' };
  return await authState();
}

async function touchLastSeen(userId: string): Promise<void> {
  const { error } = await db()
    .from('profile')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', userId);
  // Not worth failing a page load over: this column drives an admin column, nothing a user sees.
  if (error) console.warn('could not record last seen', error.message);
}

/** The id every project-scoped query below is filtered by. Throws `NoActiveProject` rather than
 *  returning null, so a handler cannot forget to check and quietly read nothing. */
export async function activeProjectId(): Promise<string> {
  const session = await requireSession();
  if (projectCache?.userId === session.user.id) return projectCache.projectId;

  const profile = await readProfile(session.user.id, session.user.email ?? '');
  if (profile.activeProjectId) {
    projectCache = { userId: session.user.id, projectId: profile.activeProjectId };
    return profile.activeProjectId;
  }

  const projects = await readMemberships();
  if (projects.length === 0) throw new NoActiveProject('you are not a member of any project yet');
  if (projects.length > 1) throw new NoActiveProject('choose which house hunt to work in');
  await setActiveProject(projects[0]!.id);
  projectCache = { userId: session.user.id, projectId: projects[0]!.id };
  return projects[0]!.id;
}

export async function setActiveProject(projectId: string): Promise<void> {
  const session = await requireSession();
  const { error } = await db()
    .from('profile')
    .update({ active_project_id: projectId })
    .eq('id', session.user.id);
  fail('switching project', error);
  projectCache = { userId: session.user.id, projectId };
}

export async function setDisplayName(displayName: string): Promise<void> {
  const session = await requireSession();
  const trimmed = displayName.trim();
  if (!trimmed) throw new Error('a name cannot be empty');
  const { error } = await db()
    .from('profile')
    .update({ display_name: trimmed })
    .eq('id', session.user.id);
  fail('saving your name', error);
}

export async function renameProject(projectId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('a project needs a name');
  const { error } = await db().from('project').update({ name: trimmed }).eq('id', projectId);
  fail('renaming the project', error);
}

export async function listMembers(projectId: string): Promise<ProjectMember[]> {
  const session = await requireSession();
  const { data, error } = await db()
    .from('project_member')
    .select('user_id, role, joined_at')
    .eq('project_id', projectId)
    .order('joined_at');
  fail('reading who is in this project', error);

  const rows = (data ?? []) as Array<{ user_id: string; role: string; joined_at: string }>;
  const names = await displayNames(rows.map((r) => r.user_id));
  return rows.map((r) => ({
    userId: r.user_id,
    email: names.get(r.user_id)?.email ?? '',
    displayName: names.get(r.user_id)?.displayName ?? 'someone in this project',
    role: r.role as 'member' | 'owner',
    joinedAt: r.joined_at,
    isYou: r.user_id === session.user.id,
  }));
}

export async function leaveProject(projectId: string): Promise<void> {
  const session = await requireSession();
  const { error } = await db()
    .from('project_member')
    .delete()
    .eq('project_id', projectId)
    .eq('user_id', session.user.id);
  fail('leaving the project', error);
  forgetActiveProject();
}

export async function headcount(projectId: string): Promise<Headcount> {
  const { data, error } = await db().rpc('project_headcount', { p_project_id: projectId });
  fail('counting who is in this project', error);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('counting who is in this project: no answer');
  return { members: row.members, pending: row.pending, maxMembers: row.max_members };
}

/** User id -> name, so a verdict can say who set it.
 *
 *  Cached for the worker's lifetime: the two or three people in a project do not change while a
 *  page is open, and this is read on every verdict list. `profile`'s policy already limits it to
 *  people you share a project with. */
const nameCache = new Map<string, { displayName: string; email: string }>();

async function displayNames(userIds: Array<string | null>): Promise<Map<string, { displayName: string; email: string }>> {
  const wanted = [...new Set(userIds.filter((id): id is string => !!id))];
  const missing = wanted.filter((id) => !nameCache.has(id));
  if (missing.length > 0) {
    const { data, error } = await db()
      .from('profile')
      .select('id, display_name, email')
      .in('id', missing);
    fail('reading who set a verdict', error);
    for (const row of (data ?? []) as Array<{ id: string; display_name: string | null; email: string }>) {
      nameCache.set(row.id, {
        displayName: row.display_name?.trim() || row.email,
        email: row.email,
      });
    }
  }
  return new Map(wanted.flatMap((id) => (nameCache.has(id) ? [[id, nameCache.get(id)!] as const] : [])));
}

// ------------------------------------------------------------------------------------------------
// Listings.
// ------------------------------------------------------------------------------------------------

/** Record that this project opened this listing, and link it to the project. One call.
 *
 *  This used to be two steps — insert the `project_property` link, then call `record_property`,
 *  which refused unless the link existed. That could never work for a listing nobody had opened:
 *  `project_property.rightmove_id` references `property`, so the link could not be written until
 *  the property row existed, and the property row could not be written until the link did. It
 *  worked only for listings some other project had already recorded, which is the case the gate
 *  was supposed to *stop*.
 *
 *  `record_property` does both writes in one transaction now. What guards the shared row is not
 *  the ordering but the function itself: it is `SECURITY DEFINER`, it checks `is_member` against
 *  the project it is asked to write as, and no client holds a delete path. */
export async function recordProperty(listing: Listing): Promise<void> {
  const projectId = await activeProjectId();

  const { error } = await db().rpc('record_property', {
    p_project_id: projectId,
    p_property: {
      rightmove_id: listing.rightmoveId,
      url: listing.url,
      postcode: listing.postcode,
      display_address: listing.displayAddress,
      price: listing.price,
      bedrooms: listing.bedrooms,
      bathrooms: listing.bathrooms,
      latitude: listing.latitude,
      longitude: listing.longitude,
      nearest_stations: listing.nearestStations,
      image_urls: listing.imageUrls,
      floorplan_urls: listing.floorplans.map((f) => f.url),
      floor_area_sqft: listing.floorArea?.sqft ?? null,
      floor_area_source: listing.floorArea?.source ?? null,
      floorplan_url: listing.floorplans[0]?.url ?? null,
      furnish_type: listing.furnishType,
      listing_update: listing.listingUpdate,
      // Stored so the analyser can read it. Two of the five amenities are only ever stated here.
      // `last_seen_at` is not passed: `record_property` stamps it itself, in the same transaction
      // as the project link, so a client clock cannot disagree with the row it wrote.
      description: listing.description,
    },
  });
  fail('recording property', error);
}

/** Add a flat from a URL somebody pasted, shared or typed.
 *
 *  The extension's route into the shortlist is a content script reading the page you are standing
 *  on. This is the other route, and it is what the phone has: the `listing` Edge Function fetches
 *  that one page and decodes it with the same code, and what comes back is recorded here exactly as
 *  the extension records its own. There is no second way into `property` — both end at
 *  `record_property`.
 *
 *  The URL is checked here as well as on the server. Not belt-and-braces: a paste that is a search
 *  page, or a link to the agent's own site, is by far the commonest mistake, and answering it from
 *  the field the reader is looking at beats a round trip to be told the same thing. The server's
 *  check is the one that matters — this one is only allowed to be a *quicker* no, never a yes the
 *  server would refuse.
 */
export async function addListingByUrl(url: string): Promise<AddListingResult> {
  const id = rightmoveListingId(url);
  if (!id) return { status: 'not-a-listing' };

  await requireSession();
  const projectId = await activeProjectId();

  // Asked before the fetch, so a flat this hunt already has costs nobody a request to Rightmove —
  // which is the no-crawl rule showing up as an optimisation, and the common case when somebody
  // shares a link that has already been round the group.
  const { data: existing, error: lookupError } = await db()
    .from('project_property')
    .select('rightmove_id, property!inner(display_address)')
    .eq('project_id', projectId)
    .eq('rightmove_id', id)
    .maybeSingle();
  fail('looking for that flat', lookupError);
  if (existing) {
    return {
      status: 'already-here',
      rightmoveId: id,
      displayAddress: (existing as any).property?.display_address ?? 'this flat',
    };
  }

  const { data, error } = await db().functions.invoke('listing', {
    body: { url },
    headers: await functionHeaders(),
  });
  if (error) return { status: 'failed', message: await refusalFrom(error, 'could not read that listing') };

  const reply = data as any;
  if (reply?.status === 'rate-limited') {
    return {
      status: 'rate-limited',
      used: reply.used ?? 0,
      limit: reply.limit ?? 0,
      retryAfterSeconds: reply.retry_after_seconds ?? 3600,
    };
  }
  if (reply?.status === 'withdrawn') return { status: 'withdrawn', rightmoveId: reply.rightmoveId ?? id };
  if (reply?.status !== 'read' || !reply.listing) {
    // Including `unreadable`, whose message names what failed to decode. Said rather than
    // swallowed: this is the shape that means Rightmove has changed the page, and the panel on the
    // laptop is about to stop working too.
    return { status: 'failed', message: reply?.message ?? 'that listing could not be read' };
  }

  const listing = reply.listing as Listing;
  await recordProperty(listing);
  return { status: 'added', rightmoveId: listing.rightmoveId, displayAddress: listing.displayAddress };
}

/** The project's verdicts for these listings — at most one per listing now (design D6).
 *
 *  `person` on the way out is the *author* of the rating rather than the owner of a private
 *  opinion: `set_by_name` for the eighteen rows written under the old identity model, and the
 *  setter's display name for everything since. Showing it alongside `updatedAt` is what keeps
 *  last-write-wins honest — a shared rating whose author is invisible turns a disagreement into a
 *  silent overwrite. */
export async function getVerdicts(rightmoveIds: string[]): Promise<Verdict[]> {
  if (rightmoveIds.length === 0) return [];
  const projectId = await activeProjectId();
  const { data, error } = await db()
    .from('verdict')
    .select('rightmove_id, rating, note, set_by, set_by_name, updated_at')
    .eq('project_id', projectId)
    .in('rightmove_id', rightmoveIds);
  fail('loading verdicts', error);

  const rows = (data ?? []) as Array<{
    rightmove_id: string;
    rating: string;
    note: string;
    set_by: string | null;
    set_by_name: string | null;
    updated_at: string;
  }>;
  const names = await displayNames(rows.map((r) => r.set_by));
  return rows.map((r) => ({
    rightmoveId: r.rightmove_id,
    person: authorOf(r.set_by, r.set_by_name, names),
    rating: r.rating as Rating,
    note: r.note,
    updatedAt: r.updated_at,
  }));
}

function authorOf(
  setBy: string | null,
  setByName: string | null,
  names: Map<string, { displayName: string }>,
): string {
  if (setBy && names.has(setBy)) return names.get(setBy)!.displayName;
  // The eighteen migrated rows carry a typed-in name and no user id until the one-shot mapping in
  // D12 step 4 runs. "someone" rather than a blank: a blank reads as a bug in the renderer.
  return setByName?.trim() || 'someone';
}

export async function setVerdict(rightmoveId: string, rating: Rating, note: string): Promise<void> {
  const session = await requireSession();
  const projectId = await activeProjectId();
  const { error } = await db().from('verdict').upsert(
    {
      project_id: projectId,
      rightmove_id: rightmoveId,
      rating,
      note,
      set_by: session.user.id,
      // Cleared deliberately: a row this account has just written is authored by this account, and
      // leaving a stale typed-in name beside it would attribute the new rating to the old author.
      set_by_name: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'project_id,rightmove_id' },
  );
  fail('saving verdict', error);
}

// ------------------------------------------------------------------------------------------------
// The funnel — how far a place has got, which is not the same question as how much you like it.
//
// Nothing here writes a verdict and nothing in the verdict half writes a stage. The one link
// between them is `enter_funnel`, a trigger on `verdict`: liking a place puts it in the funnel at
// `shortlisted`. It is in the database rather than here so that rating one flat in the panel and
// rating thirty in bulk from triage cannot end up meaning different things.
// ------------------------------------------------------------------------------------------------

const STAGE_COLUMNS = 'rightmove_id, stage, archive_reason, note, set_by, updated_at';

function toStage(row: any, names: Map<string, { displayName: string }>): PropertyStage {
  return {
    rightmoveId: row.rightmove_id,
    stage: row.stage as Stage,
    archiveReason: (row.archive_reason ?? null) as ArchiveReason | null,
    note: row.note ?? '',
    // No `set_by_name` fallback here, unlike a verdict: this table is younger than accounts are, so
    // there is no pre-auth row it could be describing.
    person: (row.set_by && names.get(row.set_by)?.displayName) || 'someone',
    updatedAt: row.updated_at,
  };
}

/** Where these listings have got to, for the panel. At most one row per listing. */
export async function getStages(rightmoveIds: string[]): Promise<PropertyStage[]> {
  if (rightmoveIds.length === 0) return [];
  const projectId = await activeProjectId();
  const { data, error } = await db()
    .from('property_stage')
    .select(STAGE_COLUMNS)
    .eq('project_id', projectId)
    .in('rightmove_id', rightmoveIds);
  fail('loading where these places have got to', error);

  const rows = (data ?? []) as any[];
  const names = await displayNames(rows.map((r) => r.set_by));
  return rows.map((r) => toStage(r, names));
}

/** Move a place along the funnel — or archive it, which is the one move that has to say why.
 *
 *  The verdict is deliberately untouched. Archiving a flat you loved because somebody outbid you
 *  must leave it recorded as loved, or the score learns the opposite of what happened. */
export async function setStage(
  rightmoveId: string,
  stage: Stage,
  archiveReason: ArchiveReason | null = null,
  note = '',
): Promise<void> {
  const session = await requireSession();
  const projectId = await activeProjectId();
  // The database enforces this too (`property_stage_reason`), and a constraint violation arrives as
  // "new row violates check constraint" — true, and no use to anybody reading a toast.
  if (stage === 'archived' && !archiveReason) throw new Error('say why it is being archived');
  const { error } = await db().from('property_stage').upsert(
    {
      project_id: projectId,
      rightmove_id: rightmoveId,
      stage,
      archive_reason: stage === 'archived' ? archiveReason : null,
      note,
      set_by: session.user.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'project_id,rightmove_id' },
  );
  fail('saving where this place has got to', error);
}

// ------------------------------------------------------------------------------------------------
// Verdict score — the project's own taste, as a classifier.
//
// The model is fitted server-side (the `predict` function) and read here; scoring happens in the
// view, at render, against these weights — so a score is never stored and never stale. Three calls:
// read the stored model, ask the server to retrain, and withhold a flat from training.
// ------------------------------------------------------------------------------------------------

/** The project's fitted model, or null when it has never been trained (or too few verdicts to). */
export interface StoredModel {
  model: Model;
  version: number;
  labelMode: LabelMode;
  nExamples: number;
  trainedAt: string;
}

export async function getProjectModel(): Promise<StoredModel | null> {
  const projectId = await activeProjectId();
  const { data, error } = await db()
    .from('project_model')
    .select('model, version, label_mode, n_examples, trained_at')
    .eq('project_id', projectId)
    .maybeSingle();
  fail('loading the model', error);
  if (!data) return null;
  const model = data.model as Model;
  // The version is the whole reason the model carries one: a v1 blob scored by a v2 feature builder
  // is not a worse score, it is a meaningless one — the columns no longer mean what the weights
  // were fitted against. Every surface reads the model through this door, so refusing it here is
  // what keeps the triage list and the panel from quietly scoring against a stale spec. "No model"
  // is a state both already render (as "rerun ratings"), which is the right thing to say.
  if (data.version !== MODEL_VERSION || model?.version !== MODEL_VERSION) return null;
  return {
    model,
    version: data.version,
    labelMode: data.label_mode as LabelMode,
    nExamples: data.n_examples,
    trainedAt: data.trained_at,
  };
}

/** What "Rerun ratings" gets back: trained (with the metrics the UI shows), or a request for more
 *  verdicts. Mirrors the `predict` function's response so a refusal is a sentence, not a 500. */
export type RetrainResult =
  | { status: 'trained'; labelMode: LabelMode; nExamples: number; metrics: ModelMetrics }
  | { status: 'insufficient'; nExamples: number; positives: number; minPerClass: number };

export async function retrainModel(labelMode?: LabelMode): Promise<RetrainResult> {
  await requireSession();

  // A route on the website rather than an Edge Function. The fit is the one piece of work Supabase's
  // hosted runtime could not run: it caps CPU at 2s per request, which the retrain crossed at around
  // 200 examples — last success at 187, and nothing but "not enough compute resources" thereafter.
  // `apps/web/src/app/api/predict/route.ts` has the rest of that argument.
  //
  // Relative, so it follows whichever origin the page is served from — production, a Vercel preview,
  // or localhost — rather than becoming a fourth copy of that URL to keep in step. Which is also why
  // the extension cannot call this: a relative fetch from the background worker resolves against
  // `chrome-extension://` and would 404 with a body that parses as nothing. Nothing does today —
  // "Rerun ratings" is a website button — and this refuses rather than leaving that 404 for whoever
  // tries it next. Moving it back within reach of the extension means giving it an absolute origin,
  // deliberately, not deleting this check.
  const origin = globalThis.location?.origin ?? '';
  if (!/^https?:/.test(origin)) {
    throw new Error(
      `retraining runs on the website and cannot be reached from ${origin || 'here'} — open the app to rerun ratings`,
    );
  }

  const response = await fetch('/api/predict', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await functionHeaders()) },
    body: JSON.stringify(labelMode ? { labelMode } : {}),
  });
  // Same convention the Edge Functions answered on, and for the same reason: a refusal carries a
  // sentence in `error`, and losing it turns something somebody can act on into "it broke".
  const payload = (await response.json().catch(() => null)) as
    | (RetrainResult & { error?: string })
    | null;
  if (!response.ok) {
    throw new Error(payload?.error || `could not retrain the model (${response.status})`);
  }
  if (!payload) throw new Error('the retrain returned nothing readable');
  return payload as RetrainResult;
}

/** The flats this project has withheld from training — off the market, usually. Returned as a list
 *  of rightmove ids: the model reads it to leave them out, and the shortlist reads it to stop
 *  drawing them among the places you can still act on (`withoutOffMarket`). */
export async function listOffMarket(): Promise<string[]> {
  const projectId = await activeProjectId();
  const { data, error } = await db()
    .from('training_exclusion')
    .select('rightmove_id')
    .eq('project_id', projectId);
  fail('loading off-market flats', error);
  return (data ?? []).map((r: any) => r.rightmove_id);
}

/** Mark a flat off the market (withhold it from training) or put it back. The verdict is never
 *  touched — a place you loved is still a place you loved; this only stops the model learning from
 *  a listing you can no longer act on. */
export async function setOffMarket(rightmoveId: string, off: boolean, reason = ''): Promise<void> {
  const session = await requireSession();
  const projectId = await activeProjectId();
  if (off) {
    const { error } = await db().from('training_exclusion').upsert(
      { project_id: projectId, rightmove_id: rightmoveId, reason, set_by: session.user.id },
      { onConflict: 'project_id,rightmove_id' },
    );
    fail('marking off market', error);
  } else {
    const { error } = await db()
      .from('training_exclusion')
      .delete()
      .eq('project_id', projectId)
      .eq('rightmove_id', rightmoveId);
    fail('marking on market', error);
  }
}

/** This hunt's preferences — a great-room bar and the must-have/nice-to-have amenities — read whole
 *  and handed to `flagsFor`. Absent (no row yet) is an empty set of preferences, which is the same
 *  as the default behaviour, so a hunt that never opened Settings sees exactly what it saw before. */
export async function getProjectSettings(): Promise<HuntPreferences> {
  const projectId = await activeProjectId();
  const { data, error } = await db()
    .from('project_setting')
    .select('preferences')
    .eq('project_id', projectId)
    .maybeSingle();
  fail('reading hunt preferences', error);
  return ((data?.preferences as HuntPreferences | undefined) ?? {}) satisfies HuntPreferences;
}

/** Save this hunt's preferences, replacing the stored set. Member-scoped, like a verdict — anyone in
 *  the project can adjust what the project is looking for. `updated_by` is pinned to the caller so a
 *  change records who made it, exactly as the RLS policy requires. */
export async function setProjectSettings(preferences: HuntPreferences): Promise<void> {
  const session = await requireSession();
  const projectId = await activeProjectId();
  const { error } = await db().from('project_setting').upsert(
    { project_id: projectId, preferences, updated_by: session.user.id, updated_at: new Date().toISOString() },
    { onConflict: 'project_id' },
  );
  fail('saving hunt preferences', error);
}

// ------------------------------------------------------------------------------------------------
// Places.
// ------------------------------------------------------------------------------------------------

const PLACE_COLUMNS =
  'id, label, postcode, lat, lon, rightmove_location_id, display_location_id, sweep_radius_miles, max_days_since_added';

function toPlace(r: any): Place {
  return {
    id: r.id,
    label: r.label,
    postcode: r.postcode ?? null,
    lat: r.lat,
    lon: r.lon,
    locationIdentifier: r.rightmove_location_id ?? null,
    displayLocationIdentifier: r.display_location_id ?? null,
    // Postgres hands `numeric` back as a string, so a radius that survived the round trip would
    // otherwise compare and format as "1.0" rather than 1 — and reach the URL as a string that
    // happens to look right until somebody does arithmetic with it.
    sweepRadiusMiles: r.sweep_radius_miles === null || r.sweep_radius_miles === undefined
      ? null
      : Number(r.sweep_radius_miles),
    maxDaysSinceAdded: r.max_days_since_added ?? null,
  };
}

export async function listPlaces(): Promise<Place[]> {
  const projectId = await activeProjectId();
  const { data, error } = await db()
    .from('place')
    .select(PLACE_COLUMNS)
    .eq('project_id', projectId)
    .order('sort_order')
    .order('created_at');
  fail('loading places', error);
  return (data ?? []).map(toPlace);
}

export async function addPlace(label: string, postcode: string): Promise<Place> {
  const projectId = await activeProjectId();
  // Resolve before saving: a postcode that can't be located produces silently missing travel
  // times later, and the moment to catch that is while the person is looking at the field.
  // A terminated postcode still resolves — the function falls back to its last known location —
  // it just no longer signals the fact back here, where it was only ever a console note.
  const point = await locatePostcode(postcode);
  if (!point) throw new Error(`"${postcode}" is not a UK postcode we can find — check it?`);

  const { data, error } = await db()
    .from('place')
    .insert({ project_id: projectId, label, postcode, lat: point.lat, lon: point.lon })
    .select(PLACE_COLUMNS)
    .single();
  fail('adding place', error);
  if (!data) throw new Error('adding place: no row returned');
  return toPlace(data);
}

/** Change what a place is *for*: whether it is swept around, how far, and how often.
 *
 *  Deliberately not a general-purpose row patcher. The label and the postcode are what the place
 *  *is* — changing either means resolving a coordinate again, which `addPlace` does on the way in —
 *  and everything here is what the hunt *does with* it. */
export async function updatePlace(
  id: string,
  patch: {
    locationIdentifier?: string | null;
    displayLocationIdentifier?: string | null;
    sweepRadiusMiles?: number | null;
    maxDaysSinceAdded?: number | null;
  },
): Promise<Place> {
  const projectId = await activeProjectId();
  const row: Record<string, unknown> = {};
  if (patch.locationIdentifier !== undefined) row.rightmove_location_id = patch.locationIdentifier;
  if (patch.displayLocationIdentifier !== undefined) {
    row.display_location_id = patch.displayLocationIdentifier;
  }
  if (patch.sweepRadiusMiles !== undefined) row.sweep_radius_miles = patch.sweepRadiusMiles;
  if (patch.maxDaysSinceAdded !== undefined) row.max_days_since_added = patch.maxDaysSinceAdded;
  if (Object.keys(row).length === 0) throw new Error('nothing to change about this place');

  const { data, error } = await db()
    .from('place')
    .update(row)
    .eq('id', id)
    .eq('project_id', projectId)
    .select(PLACE_COLUMNS)
    .single();
  fail('changing a place', error);
  if (!data) throw new Error('changing a place: no row returned');
  return toPlace(data);
}

/** Fill in coordinates for places saved before we resolved them. */
export async function backfillPlaceCoords(place: Place): Promise<Place> {
  if (place.lat !== null && place.lon !== null) return place;
  // A place with no postcode arrived as a neighbourhood, resolved by name. There is nothing to
  // look up, and inventing a coordinate is the one thing this must never do.
  if (place.postcode === null) return place;
  const point = await locatePostcode(place.postcode);
  if (!point) return place;
  const projectId = await activeProjectId();
  const { error } = await db()
    .from('place')
    .update({ lat: point.lat, lon: point.lon })
    .eq('id', place.id)
    .eq('project_id', projectId);
  fail('backfilling place coordinates', error);
  return { ...place, lat: point.lat, lon: point.lon };
}

export async function removePlace(id: string): Promise<void> {
  const projectId = await activeProjectId();
  const { error } = await db().from('place').delete().eq('id', id).eq('project_id', projectId);
  fail('removing place', error);
}

// ------------------------------------------------------------------------------------------------
// The travel cache, now keyed on two postcodes rather than on a place (design D5).
// ------------------------------------------------------------------------------------------------

export interface CachedTravel {
  /** The place's postcode, not its id. A journey between two postcodes is a fact about London and
   *  is shared across projects; keying it on a project's `place` row made every project pay TfL
   *  again for the same trip. The caller maps back to its own places. */
  destPostcode: string;
  mode: TravelMode;
  seconds: number | null;
  changes: number | null;
  options: JourneyOption[] | null;
  /** TfL answered, and the answer was "there is no such journey". A cached fact, not a failure. */
  noRoute: boolean;
  /** Why there is no number, where the row knows — TfL's own message, or our own refusal to ask
   *  about a walk nobody could make inside the hour. Null on rows written before the column
   *  existed, which is honestly "no more than `noRoute` says". */
  reason: string | null;
  /** What this number means — see `TRAVEL_BASIS` in tfl.ts. Null on every row written before we
   *  started pinning transit to a weekday morning, which is to say: measured at an unknown time
   *  of day, and not comparable with anything. */
  basis: string | null;
  computedAt: string;
}

function toCachedTravel(r: any): CachedTravel {
  return {
    destPostcode: r.dest_postcode,
    mode: r.mode as TravelMode,
    seconds: r.seconds,
    changes: r.changes,
    options: (r.journeys ?? null) as JourneyOption[] | null,
    noRoute: r.no_route ?? false,
    reason: r.reason ?? null,
    basis: r.basis ?? null,
    computedAt: r.computed_at,
  };
}

export async function getCachedTravel(postcode: string): Promise<CachedTravel[]> {
  const { data, error } = await db()
    .from('travel_time')
    .select('dest_postcode, mode, seconds, changes, no_route, reason, journeys, basis, computed_at')
    .eq('origin_postcode', postcode);
  fail('reading travel cache', error);
  return (data ?? []).map(toCachedTravel);
}

/** What each of these flats has cost, newest first, keyed by listing.
 *
 *  One query for the whole shortlist rather than one per card, for the same reason the travel cache
 *  is read in a batch: the list view renders two hundred rows and a request each would be two
 *  hundred round trips to answer a question that is four words on the card.
 *
 *  A listing with one row has never moved; one with none has never been priced. Both come back
 *  absent from the map, and `latestChange` reads either as "no change to report" — which is the
 *  honest answer, since a flat we have only ever seen once has not been observed changing. */
export async function getPriceHistoryFor(
  rightmoveIds: string[],
): Promise<Map<string, PricePoint[]>> {
  const by = new Map<string, PricePoint[]>();
  if (rightmoveIds.length === 0) return by;

  const { data, error } = await db()
    .from('property_price')
    .select('id, rightmove_id, price, seen_at')
    .in('rightmove_id', [...new Set(rightmoveIds)])
    .order('seen_at', { ascending: false })
    // The tie-break, and the reason the surrogate key exists at all. `clock_timestamp()` does not
    // promise two distinct readings, and two observations sharing one come back in whichever order
    // Postgres feels like — which decides whether the card reads "reduced" or "up".
    .order('id', { ascending: false });
  fail('reading price history', error);

  for (const r of (data ?? []) as any[]) {
    const list = by.get(r.rightmove_id) ?? [];
    list.push({ price: r.price, seenAt: r.seen_at, id: r.id });
    by.set(r.rightmove_id, list);
  }
  return by;
}

/** Every cached travel time for a set of origin postcodes, in one query, keyed by origin.
 *
 *  The compare table needs a number for seventeen places at once. Asking `travel:get` per
 *  property would be seventeen round trips, and worse, each one would call TfL for anything not
 *  yet cached — turning opening a table into a hundred journey-planner requests. This reads the
 *  cache and nothing else: a gap stays a gap, and the table says so. */
export async function getCachedTravelFor(
  postcodes: string[],
): Promise<Map<string, CachedTravel[]>> {
  const by = new Map<string, CachedTravel[]>();
  if (postcodes.length === 0) return by;

  const { data, error } = await db()
    .from('travel_time')
    .select('origin_postcode, dest_postcode, mode, seconds, changes, no_route, reason, journeys, basis, computed_at')
    .in('origin_postcode', [...new Set(postcodes)]);
  fail('reading travel cache', error);

  for (const r of (data ?? []) as any[]) {
    const list = by.get(r.origin_postcode) ?? [];
    list.push(toCachedTravel(r));
    by.set(r.origin_postcode, list);
  }
  return by;
}

/** Cache an answer from TfL — including "no such journey", which is every bit as permanent as a
 *  duration. Leaving negatives out meant a listing whose walk to Heathrow can't be planned
 *  re-asked TfL on every single page load, and those failing calls are the slow ones: for one N1
 *  postcode, 6 of 9 legs came from cache and the other 3 were the same 404s every time.
 *
 *  Transient failures are deliberately NOT cached — those are the ones worth retrying.
 *
 *  Goes through an RPC because `travel_time` is a shared fact table and `authenticated` holds no
 *  write on it: a blanket grant would include DELETE, and one buggy client could empty a cache
 *  every project depends on (design D4). The RPC also refuses an implausible duration, which the
 *  NOT NULL constraint never did. */
/** The three shared caches — `travel_time`, `station_point`, `station_walk` — are written by the
 *  `travel` Edge Function and by nothing else, so the write helpers that used to live here are
 *  gone rather than deprecated.
 *
 *  Leaving them would leave an invitation. Their RPCs are granted to `service_role` alone now, so
 *  a call from either client is `permission denied` — and a helper whose only possible outcome is
 *  a refusal is worse than no helper at all, because it reads as a supported thing to do. The
 *  readers below stay: reading these tables is exactly what every surface does.
 *
 *  Why the writes moved is on `supabase/functions/travel/index.ts`. Short version: the tables are
 *  global on purpose, and validation there could only ever check that a number was plausible, not
 *  that it was true. */

export async function getStationWalks(postcode: string): Promise<Map<string, number>> {
  const { data, error } = await db()
    .from('station_walk')
    .select('station_name, seconds')
    .eq('postcode', postcode);
  fail('reading station walks', error);
  return new Map(((data ?? []) as any[]).map((r) => [r.station_name as string, r.seconds as number]));
}

export async function getStationPoint(name: string): Promise<StationInfo | null | undefined> {
  const { data, error } = await db()
    .from('station_point')
    .select('lat, lon, lines')
    .eq('name', name)
    .maybeSingle();
  fail('reading station point', error);
  if (!data) return undefined; // never looked up
  return data.lat === null || data.lon === null
    ? null
    : { lat: data.lat, lon: data.lon, lines: (data.lines ?? []) as string[] };
}

/** The columns of `property_analysis` that become facts — every one `toAnalysis` reads, and no
 *  other. Named rather than `*`, because the row also carries `captions` (one per photo) and `raw`
 *  (the model's whole reply), which nothing on either surface reads and which weigh more than
 *  everything else on the row put together. Embedded into the shortlist for four hundred flats,
 *  `*` made that one request 2.8 MB and ten seconds — the page's entire time-to-first-card. */
const ANALYSIS_COLUMNS =
  'rightmove_id, status, model, analysed_at, image_count, has_floorplan, floorplan_sqft, ' +
  'floorplan_sqft_source, floorplan_confidence, floorplan_legible, bedrooms, bathrooms, ' +
  'biggest_room_label, biggest_room_sqft, biggest_room_confidence, has_bathtub, bathtub_confidence, ' +
  'has_outdoor_space, outdoor_kind, outdoor_sqft, outdoor_is_estimate, outdoor_confidence, ' +
  'has_dishwasher, dishwasher_confidence, laundry, laundry_confidence, natural_light, ' +
  'natural_light_confidence, sleeping_separation, sleeping_separation_confidence, ' +
  'utilities_included, utilities_confidence, is_house_share, house_share_confidence, summary';

export async function getAnalysis(rightmoveId: string): Promise<Analysis | null> {
  // A claimed-but-unfinished row, or a failed one, is not an analysis — returning it would
  // render a panel full of nulls that looks like a confident "nothing found".
  const { data, error } = await db()
    .from('property_analysis')
    .select(ANALYSIS_COLUMNS)
    .eq('rightmove_id', rightmoveId)
    .eq('status', 'done')
    .maybeSingle();
  fail('loading analysis', error);
  return data ? toAnalysis(data) : null;
}

/** Every `property_analysis` row reaching either application comes through here — the panel's
 *  single read and the shortlist's join both call it — which makes it the one place a stored value
 *  becomes a fact. Exported so `check:filter` can put a row through it rather than assemble an
 *  `Analysis` by hand: a check that builds the object itself agrees with whatever this function
 *  does, including the wrong thing. */
export function toAnalysis(data: Record<string, any>): Analysis {
  return {
    model: data.model,
    analysedAt: data.analysed_at,
    imageCount: data.image_count,
    hasFloorplan: data.has_floorplan,
    floorplanLegible: data.floorplan_legible ?? null,
    floorplanSqft: data.floorplan_sqft,
    floorplanSqftSource: data.floorplan_sqft_source,
    floorplanConfidence: data.floorplan_confidence as Confidence | null,
    bedrooms: data.bedrooms,
    bathrooms: data.bathrooms,
    biggestRoomLabel: data.biggest_room_label,
    biggestRoomSqft: data.biggest_room_sqft,
    biggestRoomConfidence: data.biggest_room_confidence as Confidence | null,
    hasBathtub: data.has_bathtub,
    bathtubConfidence: data.bathtub_confidence as Confidence | null,
    hasOutdoorSpace: data.has_outdoor_space,
    outdoorKind: data.outdoor_kind,
    outdoorSqft: data.outdoor_sqft,
    outdoorIsEstimate: data.outdoor_is_estimate,
    outdoorConfidence: data.outdoor_confidence as Confidence | null,
    isHouseShare: data.is_house_share ?? null,
    houseShareConfidence: (data.house_share_confidence ?? null) as Confidence | null,
    laundry: (data.laundry ?? null) as Analysis['laundry'],
    laundryConfidence: (data.laundry_confidence ?? null) as Confidence | null,
    hasDishwasher: data.has_dishwasher ?? null,
    dishwasherConfidence: (data.dishwasher_confidence ?? null) as Confidence | null,
    // Parsed rather than asserted: the column is plain text, and a value that is not one of the
    // three must read as unknown rather than as a bed with its own room. See `toSleepingSeparation`.
    sleepingSeparation: toSleepingSeparation(data.sleeping_separation),
    sleepingSeparationConfidence: (data.sleeping_separation_confidence ?? null) as Confidence | null,
    utilitiesIncluded: data.utilities_included ?? null,
    utilitiesConfidence: (data.utilities_confidence ?? null) as Confidence | null,
    naturalLight: (data.natural_light ?? null) as Analysis['naturalLight'],
    naturalLightConfidence: (data.natural_light_confidence ?? null) as Confidence | null,
    summary: data.summary,
  };
}

// ------------------------------------------------------------------------------------------------
// The shortlist.
// ------------------------------------------------------------------------------------------------

/** One row per property this project has opened, with everything needed to judge it without going
 *  back to Rightmove. Read by the shortlist page. */
export interface ShortlistEntry {
  rightmoveId: string;
  url: string;
  displayAddress: string;
  postcode: string | null;
  price: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  floorAreaSqft: number | null;
  /** Whether Rightmove published that number as data or we parsed it out of the description —
   *  the difference decides how much it is trusted, and whether it is marked as approximate. */
  floorAreaSource: 'sizings' | 'description' | null;
  floorplanUrl: string | null;
  /** Rightmove's own URLs. We link and display; we never re-host (their ToS 13.4). */
  imageUrls: string[];
  furnishType: string | null;
  listingUpdate: string | null;
  nearestStations: Station[];
  lastSeenAt: string;
  lat: number | null;
  lon: number | null;
  /** False when we fell back to Rightmove's fuzzed pin, so the map can say so. */
  exactLocation: boolean;
  /** At most one now: the project shares a single rating per property (design D6). Kept as a list
   *  so `groupOf` and `enthusiasm` in lib/shortlist.ts read unchanged. */
  verdicts: Verdict[];
  /** Where this place has got to, or null for one nobody has liked yet. Separate from the verdict
   *  on purpose — see `packages/core/src/stage.ts`. */
  stage: PropertyStage | null;
  analysis: Analysis | null;
}

/** The project's shortlist in one round trip.
 *
 *  `property` is global now, so "everything in the table" is the wrong list — it would show a
 *  project every listing every other project has ever opened. `project_property!inner` is the
 *  membership list, and the embed still brings the verdict and the analysis back in the same
 *  request rather than one per property. */
export async function getShortlist(): Promise<ShortlistEntry[]> {
  const projectId = await activeProjectId();
  const { data, error } = await db()
    .from('property')
    .select(
      'rightmove_id, url, display_address, postcode, price, bedrooms, bathrooms, floor_area_sqft, floor_area_source, floorplan_url, image_urls, furnish_type, listing_update, nearest_stations, last_seen_at, latitude, longitude, postcode_lat, postcode_lon, verdict(*), property_stage(*), ' +
        // Named columns, not `*` — see `ANALYSIS_COLUMNS` for the two this leaves behind and why.
        `property_analysis(${ANALYSIS_COLUMNS}), project_property!inner(project_id, last_seen_at)`,
    )
    .eq('project_property.project_id', projectId)
    // Scoped for exactly the reason the verdict embed below is, and with the same consequence if it
    // were left off: a flat two projects are both chasing would arrive carrying both funnels, and
    // whichever the planner returned first would be shown as this project's.
    .eq('property_stage.project_id', projectId)
    // The embedded verdict needs the same filter as the membership list, and for a different
    // reason. `project_property!inner` decides *which properties* appear; this decides *whose
    // opinion* comes back with them. RLS lets a member of two projects read the verdicts of both,
    // so a flat both projects opened would arrive carrying two ratings and `verdicts[0]` would be
    // whichever the planner returned first — the other project's "no" shown as this one's. Not
    // `!inner`: an unrated property must still appear, and that is the whole triage pile.
    .eq('verdict.project_id', projectId)
    .order('last_seen_at', { ascending: false });
  fail('loading the shortlist', error);

  const rows = (data ?? []) as any[];
  // PostgREST returns an embedded row as an object or as an array depending on how it reads the
  // relationship, and both shapes turn up here — so every embed is normalised the same way rather
  // than each caller guessing.
  const embedded = (value: any): any[] => (Array.isArray(value) ? value : value ? [value] : []);
  const verdictRows = rows.flatMap((row) => embedded(row.verdict));
  const stageRows = rows.flatMap((row) => embedded(row.property_stage));
  const names = await displayNames([...verdictRows, ...stageRows].map((r: any) => r.set_by));

  return rows.map((row: any) => {
    // A claimed-but-unfinished analysis row is not an analysis; the panel applies the same rule.
    const analysisRow = (row.property_analysis ?? []).find?.((a: any) => a.status === 'done')
      ?? (row.property_analysis?.status === 'done' ? row.property_analysis : null);
    const verdicts = embedded(row.verdict);
    const stageRow = embedded(row.property_stage)[0] ?? null;

    return {
      rightmoveId: row.rightmove_id,
      url: row.url,
      displayAddress: row.display_address,
      postcode: row.postcode,
      price: row.price,
      bedrooms: row.bedrooms,
      bathrooms: row.bathrooms,
      floorAreaSqft: row.floor_area_sqft,
      floorAreaSource: row.floor_area_source ?? null,
      floorplanUrl: row.floorplan_url,
      imageUrls: (row.image_urls ?? []) as string[],
      furnishType: row.furnish_type ?? null,
      listingUpdate: row.listing_update ?? null,
      nearestStations: (row.nearest_stations ?? []) as Station[],
      // This project's last sighting, not the global one. `property.last_seen_at` is bumped by
      // whichever project last opened the listing, so ordering on it would let another project's
      // evening reshuffle this one's shortlist. The fallback is for the seeded rows, whose link
      // carried the property's own dates across.
      lastSeenAt: row.project_property?.[0]?.last_seen_at ?? row.last_seen_at,
      // Postcode-derived coordinates first: Rightmove's own pin is deliberately fuzzed
      // (pinType: "APPROXIMATE_POINT"), which is fine on their map and wrong on ours, where two
      // flats a street apart is the whole question.
      lat: row.postcode_lat ?? row.latitude ?? null,
      lon: row.postcode_lon ?? row.longitude ?? null,
      exactLocation: row.postcode_lat !== null && row.postcode_lat !== undefined,
      verdicts: verdicts.map((v: any) => ({
        rightmoveId: v.rightmove_id,
        person: authorOf(v.set_by ?? null, v.set_by_name ?? null, names),
        rating: v.rating as Rating,
        note: v.note,
        updatedAt: v.updated_at,
      })),
      stage: stageRow ? toStage(stageRow, names) : null,
      analysis: analysisRow ? toAnalysis(analysisRow) : null,
    };
  })
    // The server ordered on the global column; the field above is the project's own. Re-sorting
    // here rather than asking PostgREST to order on an embedded table, which it cannot do.
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

/** What we already know about a property we have only seen on a search page.
 *
 *  Three states, and the middle one is the whole reason this exists. "new" is a flat this project
 *  has not opened. "complete" is one that has been opened, located from its postcode and analysed,
 *  so there is nothing left to get. "partial" is the awkward middle — a row exists, but something a
 *  view needs is missing, usually because the tab was closed before the panel finished or because
 *  the analysis was claimed and never came back. Those are the ones worth reopening, and telling
 *  them apart from "complete" is what stops the paced auto-open from reopening the whole shortlist. */
export type SweepState = 'new' | 'partial' | 'complete';

export interface SweepKnowledge {
  rightmoveId: string;
  state: SweepState;
  /** What is missing, for the panel to show on hover. Empty when complete. */
  missing: string[];
}

/** Classify a page's worth of ids in one round trip.
 *
 *  Scoped to the project through `project_property`, not to the global `property` table. A listing
 *  another project opened and analysed is a fact we can read for free, but until *this* project
 *  links it there is no shortlist row, no verdict and nothing on the map — so it is "new", and the
 *  opener is right to open it. Reading the global table here would report it complete and the
 *  listing would silently never join the shortlist.
 *
 *  "Complete" is what re-opening the listing can actually produce: its postcode read from the page,
 *  and its photos analysed (checked through the embedded row, the same way `getShortlist` does, and
 *  only `status = 'done'` counts — a claimed-but-unfinished row is not an analysis). Map position
 *  (`postcode_lat`) is deliberately *not* in this test: it is filled by a separate `locateProperties`
 *  backfill, and opening the tab again does nothing to produce it — so gating on it would leave every
 *  opened-but-not-yet-geocoded flat permanently in the opener's worklist, which re-opening can never
 *  clear. The map falls back to Rightmove's own pin until the backfill lands. */
export async function getSweepKnowledge(rightmoveIds: string[]): Promise<Map<string, SweepKnowledge>> {
  const known = new Map<string, SweepKnowledge>();
  if (rightmoveIds.length === 0) return known;
  const projectId = await activeProjectId();

  const { data, error } = await db()
    .from('property')
    .select('rightmove_id, postcode, property_analysis(status), project_property!inner(project_id)')
    .eq('project_property.project_id', projectId)
    .in('rightmove_id', rightmoveIds);
  fail('checking which properties we already have', error);

  for (const row of (data ?? []) as any[]) {
    const analyses = Array.isArray(row.property_analysis)
      ? row.property_analysis
      : row.property_analysis
        ? [row.property_analysis]
        : [];
    const missing: string[] = [];
    if (!row.postcode) missing.push('no postcode read from the listing');
    if (!analyses.some((a: any) => a.status === 'done')) missing.push('photos not analysed yet');

    known.set(row.rightmove_id, {
      rightmoveId: row.rightmove_id,
      state: missing.length === 0 ? 'complete' : 'partial',
      missing,
    });
  }
  return known;
}

/** One listing we have seen on a search page but do not properly have yet. */
export interface PendingSighting {
  rightmoveId: string;
  url: string;
  hub: string;
  displayAddress: string;
  price: string | null;
  /** Empty for a flat nobody has opened at all — the honest wording there is "never opened",
   *  which the view supplies rather than this pretending to a reason. */
  missing: string[];
}

/** Everything this project swept and has not filled in, across every hub.
 *
 *  This is the opener's worklist, and it is deliberately a question about the *database* rather
 *  than about the page in front of you. The opener used to live on the search-results page, which
 *  meant its worklist was the twenty-four cards on screen and it died the moment you paged on —
 *  so sweeping five hubs, four pages each, meant twenty separate unattended runs, each of which
 *  you had to sit through before navigating. Scanning is per-page and instant; filling in is one
 *  long run over everything scanned so far. They are different jobs and now have different homes.
 *
 *  "Not filled in" means the same thing here as it does in the sweep panel: no property row at
 *  all, or one still missing its location or its photo analysis. Ordered newest sighting first,
 *  because a flat that appeared this morning is the one worth opening before somebody takes it. */
export async function pendingSightings(): Promise<PendingSighting[]> {
  const projectId = await activeProjectId();
  const { data, error } = await db()
    .from('search_sighting')
    .select('rightmove_id, url, hub, display_address, price, last_seen_at')
    .eq('project_id', projectId)
    .order('last_seen_at', { ascending: false });
  fail('reading what has been swept', error);

  // A flat inside more than one hub's radius is sighted once per hub — the radii overlap on
  // purpose — and opening it twice would be twice the tabs for one listing. First sighting wins,
  // which is the newest by the ordering above.
  const rows = (data ?? []) as any[];
  const distinct = new Map<string, any>();
  for (const row of rows) if (!distinct.has(row.rightmove_id)) distinct.set(row.rightmove_id, row);

  const knowledge = await getSweepKnowledge([...distinct.keys()]);
  return [...distinct.values()].flatMap((row) => {
    const known = knowledge.get(row.rightmove_id);
    if (known?.state === 'complete') return [];
    return [
      {
        rightmoveId: row.rightmove_id,
        url: row.url,
        hub: row.hub,
        displayAddress: row.display_address,
        price: row.price,
        missing: known?.missing ?? [],
      },
    ];
  });
}

/** Drop every sighting of a listing that no longer exists, across all this project's hubs.
 *
 *  The fill-in worklist is "sighted, and not complete yet" (see `pendingSightings`), and complete
 *  needs a postcode and a finished analysis — both of which come from opening the listing. A flat
 *  the agent withdraws between the scan and the run can never supply either, so without this it
 *  stays pending for good: reopened in a background tab on every run, and inflating the count of
 *  what is left to do with flats nobody can ever do anything about.
 *
 *  Deleting rather than flagging, because the sighting is a record that Rightmove was showing this
 *  card — and it is not. If it comes back the next sweep sights it again, which is the right
 *  answer to a listing that was relisted. */
export async function forgetSightings(rightmoveId: string): Promise<void> {
  const projectId = await activeProjectId();
  const { error } = await db()
    .from('search_sighting')
    .delete()
    .eq('project_id', projectId)
    .eq('rightmove_id', rightmoveId);
  fail('forgetting a withdrawn listing', error);
}

/** Record every card on a search page as a sighting for this hub.
 *
 *  Upsert rather than insert: sweeping the same neighbourhood weekly means seeing the same flat
 *  repeatedly, and what changes between sightings is the price and the "reduced on" wording, both
 *  of which are worth keeping current. `first_seen_at` is deliberately not in the update list —
 *  it is the one column here that records something no later sighting can tell you. */
export async function recordSightings(hub: string, cards: SearchCard[]): Promise<void> {
  if (cards.length === 0) return;
  const projectId = await activeProjectId();
  const now = new Date().toISOString();

  // One row per id, whatever the page did. Rightmove puts featured listings in their own strip
  // *and* again in the results below, so the same flat arrives twice from one page — and Postgres
  // refuses an upsert whose batch touches a row twice ("ON CONFLICT DO UPDATE command cannot
  // affect row a second time"), which failed the whole page rather than the duplicate. Last
  // occurrence wins, arbitrarily and harmlessly: both copies are the same listing read from the
  // same blob.
  const byId = new Map(cards.map((card) => [card.rightmoveId, card] as const));

  const { error } = await db().from('search_sighting').upsert(
    [...byId.values()].map((card) => ({
      project_id: projectId,
      rightmove_id: card.rightmoveId,
      hub,
      url: card.url,
      display_address: card.displayAddress,
      price: card.price,
      bedrooms: card.bedrooms,
      bathrooms: card.bathrooms,
      latitude: card.latitude,
      longitude: card.longitude,
      first_visible_at: card.firstVisibleAt,
      listing_update_at: card.listingUpdateAt,
      listing_update_reason: card.listingUpdateReason,
      added_or_reduced: card.addedOrReduced,
      last_seen_at: now,
    })),
    { onConflict: 'project_id,rightmove_id,hub' },
  );
  fail('recording what this search page showed', error);
}

// ------------------------------------------------------------------------------------------------
// Hubs, which are project data now rather than compile-time constants (design D11).
// ------------------------------------------------------------------------------------------------
// Sweeps.
// ------------------------------------------------------------------------------------------------

export interface HubSweep {
  /** The place's name, which is how the sweep panel and `search_sighting` both refer to it —
   *  a record of what a search was filed under at the time, not a foreign key, so renaming a place
   *  does not rewrite history.
   *
   *  `placeId` is the `place` row it belongs to. Null only for a sweep whose neighbourhood was
   *  already gone when `places_are_hubs` ran, which is why the column is nullable — *not* for a
   *  place deleted since. Deleting a place cascades its sweep away on purpose, and the button that
   *  does it says so: the sweep history is the record of having worked that search to the end, and
   *  keeping it against a place that no longer exists would date the next window of a search
   *  nobody is running. */
  hub: string;
  placeId: string | null;
  /** The last time this hub was swept *completely*, or null for one that has never been. A hub
   *  whose pages are only half recorded is null too: it has no complete sweep to date from, and
   *  `sweepWindow` already reads null as "use the widest window", which is the answer that cannot
   *  drop listings on the floor. */
  lastSweptAt: string | null;
  lastResultCount: number | null;
  lastWindowDays: number | null;
  locationIdentifier: string | null;
  /** How many pages the sweep in progress has, or null for a sweep recorded before pages were
   *  tracked. */
  pagesTotal: number | null;
  pagesSeen: number[];
}

// The embed names its foreign key, and has to. `hub_sweep` has TWO keys onto `place`: the plain
// `place_id`, and the composite `(project_id, place_id)` that stops a sweep pointing at a place
// belonging to somebody else's project. Both are wanted. `place!inner(label)` leaves PostgREST to
// choose between them and it refuses — 300 Multiple Choices, PGRST201 — so every read through
// these columns failed, which meant the sweep panel recorded 0 of 25 cards and toasted an error on
// load. Naming the constraint is the whole fix.
//
// Nothing but a browser found this. It is invisible to `check:all` (no database) and to
// `check:rls` (which asks about the boundary, not about embeds), and the failure arrives as a
// toast rather than an exception, so the page looks like it is working.
const SWEEP_COLUMNS =
  'hub, place_id, last_swept_at, last_result_count, last_window_days, location_identifier, pages_total, pages_seen, place!hub_sweep_place_id_fkey(label)';

function toHubSweep(r: any): HubSweep {
  const place = Array.isArray(r.place) ? r.place[0] : r.place;
  return {
    // The place's current label leads, and the name the sweep was filed under is the fallback: a
    // renamed place should read by its new name, and a deleted one still has to say which search
    // its pages belong to.
    hub: place?.label ?? r.hub ?? '',
    placeId: r.place_id ?? null,
    lastSweptAt: r.last_swept_at,
    lastResultCount: r.last_result_count,
    lastWindowDays: r.last_window_days,
    locationIdentifier: r.location_identifier,
    pagesTotal: r.pages_total ?? null,
    pagesSeen: (r.pages_seen ?? []) as number[],
  };
}

export async function listHubSweeps(): Promise<HubSweep[]> {
  const projectId = await activeProjectId();
  const { data, error } = await db()
    .from('hub_sweep')
    .select(SWEEP_COLUMNS)
    .eq('project_id', projectId);
  fail('reading when each hub was last swept', error);
  return ((data ?? []) as any[]).map(toHubSweep);
}

/** The `place` row a sweep is about. Named rather than created: a sweep for a place this project
 *  does not have is a sweep against somebody else's search, and inventing the place would record it
 *  under a name nothing else knows. */
async function placeIdFor(projectId: string, hub: string, placeId?: string): Promise<string> {
  if (placeId) return placeId;
  const { data, error } = await db()
    .from('place')
    .select('id')
    .eq('project_id', projectId)
    // Case-insensitively, matching the unique index on `(project_id, lower(label))` and the way
    // the migration folded hubs in. A sweep filed under "Angel" against a place saved as "angel"
    // is the same search, and an exact match would refuse to record the page and say the place
    // does not exist.
    .ilike('label', hub)
    .maybeSingle();
  fail('finding this place', error);
  if (!data) throw new Error(`"${hub}" is not one of this project's places — add it first`);
  return data.id as string;
}

/** Record that one page of a hub's sweep has been read, and finish the sweep if that was the last
 *  one outstanding.
 *
 *  This replaces a "Mark swept" button, which was gated on exactly the condition the data already
 *  knew — that you were on the final page — and so was a human asserting something we could see.
 *  What the button was really guarding against is subtler and is still guarded against here:
 *  recording *a* page is not finishing a sweep. Results come back newest first, so treating page
 *  three of three as the end would narrow the next window past everything on pages one and two,
 *  which is the only failure in the sweep that looks exactly like success.
 *
 *  The rule itself is `sweepProgress` in lib/sweep.ts, out here where `pnpm check:sweep` can pin
 *  it. This function is the round trip around it.
 *
 *  `last_swept_at` keeps the meaning it always had: the last time this hub was swept *completely*.
 *  Nothing narrows a window on the strength of a partial pass. */
export async function recordSweepPage(
  hub: string,
  details: { page: number; totalPages: number; resultCount: number; windowDays: number; locationIdentifier: string },
  placeId?: string,
): Promise<HubSweep | null> {
  const projectId = await activeProjectId();
  const id = await placeIdFor(projectId, hub, placeId);

  const { data: existing, error: readError } = await db()
    .from('hub_sweep')
    .select('pages_total, pages_seen, last_swept_at')
    .eq('place_id', id)
    .maybeSingle();
  fail('reading this hub\'s sweep progress', readError);

  const { pagesSeen, complete } = sweepProgress(
    existing === null
      ? null
      : { pagesTotal: existing.pages_total ?? null, pagesSeen: (existing.pages_seen ?? []) as number[] },
    details.page,
    details.totalPages,
  );

  const sweptAt = complete ? new Date().toISOString() : (existing?.last_swept_at ?? null);
  const row = {
    place_id: id,
    // The name this search was filed under. Kept beside the id rather than derived from it, so a
    // sweep survives its place being renamed or deleted with a record of what it actually covered.
    hub,
    project_id: projectId,
    // Only a complete pass sets the mark. A partial one leaves whatever the last complete sweep
    // wrote — usually null — so the next window stays as wide as it needs to be.
    last_swept_at: sweptAt,
    last_result_count: details.resultCount,
    last_window_days: details.windowDays,
    location_identifier: details.locationIdentifier,
    pages_total: details.totalPages,
    pages_seen: pagesSeen,
  };

  const { data, error } = await db()
    .from('hub_sweep')
    .upsert(row, { onConflict: 'place_id' })
    .select(SWEEP_COLUMNS)
    .single();
  fail('recording sweep progress', error);
  if (!data) return null;

  // The mirror write onto `project_hub.last_swept_at` used to live here. That table is gone: the
  // sweep row above is the single record of when this place was last worked to the end,
  // and it is the only one that also knows which pages that claim rests on.
  return toHubSweep(data);
}

/** Forget which pages of this place's sweep in progress are in, before a fresh pass opens page 1.
 *
 *  For the unattended sweep, which has no tab to read and learns that a page landed only by
 *  reading this row back. Page 1 restarts the count, so "recorded" is `pages_seen = [1]` — but a
 *  pass abandoned on page 1 *last week* left exactly that, and the run would take last week's row
 *  for today's, page on before anything had been written, and stitch today's pages onto a total
 *  from a search that has since changed shape. Clearing first is what makes `[1]` mean this run.
 *
 *  Only the progress. `last_swept_at` is the record of the last *complete* pass and is what dates
 *  the next window; touching it here would widen or narrow a search on the strength of nothing. */
export async function resetSweepProgress(placeId: string): Promise<void> {
  const projectId = await activeProjectId();
  const { error } = await db()
    .from('hub_sweep')
    .update({ pages_total: null, pages_seen: [] })
    .eq('project_id', projectId)
    .eq('place_id', placeId);
  fail('clearing sweep progress', error);
}

/** Fill in postcode-accurate coordinates for anything in this project that hasn't got them.
 *  Returns how many were resolved. Idempotent: rows that already have coordinates are never
 *  looked at again.
 *
 *  The write is an RPC because `property` is a shared fact table, and it carries the project so
 *  the function can check this project actually opened the listing (design D4). */
export async function locateProperties(): Promise<number> {
  const projectId = await activeProjectId();
  const { data, error } = await db()
    .from('property')
    .select('rightmove_id, postcode, project_property!inner(project_id)')
    .eq('project_property.project_id', projectId)
    .is('postcode_lat', null)
    .not('postcode', 'is', null);
  fail('finding properties to locate', error);

  const rows = (data ?? []) as Array<{ rightmove_id: string; postcode: string }>;
  if (rows.length === 0) return 0;

  const points = await locatePostcodes(rows.map((r) => r.postcode));
  let located = 0;

  for (const row of rows) {
    const point = points.get(row.postcode);
    if (!point) continue;
    const { error: writeError } = await db().rpc('set_property_point', {
      p_project_id: projectId,
      p_rightmove_id: row.rightmove_id,
      p_lat: point.lat,
      p_lon: point.lon,
    });
    fail('saving property coordinates', writeError);
    located++;
  }
  return located;
}

// ------------------------------------------------------------------------------------------------
// Invites. The write side runs in an Edge Function with the service role, because it has to
// validate the caller's standing and create an auth user — neither of which a client may do.
// ------------------------------------------------------------------------------------------------

function toInvite(r: any): Invite {
  const project = Array.isArray(r.project) ? r.project[0] : r.project;
  return {
    id: r.id,
    email: r.email,
    projectId: r.project_id ?? null,
    projectName: project?.name ?? null,
    status: r.status,
    expired: r.status === 'pending' && new Date(r.expires_at).getTime() < Date.now(),
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    acceptedAt: r.accepted_at ?? null,
  };
}

const INVITE_COLUMNS = 'id, email, project_id, status, expires_at, created_at, accepted_at, project:project_id (name)';

export async function listInvites(projectId?: string): Promise<Invite[]> {
  let query = db().from('invite').select(INVITE_COLUMNS).order('created_at', { ascending: false });
  if (projectId) query = query.eq('project_id', projectId);
  const { data, error } = await query;
  fail('reading invites', error);
  return ((data ?? []) as any[]).map(toInvite);
}

/** An Edge Function's refusal, read out of the response rather than out of `error.message`.
 *
 *  supabase-js reports every non-2xx as the same sentence — "Edge Function returned a non-2xx
 *  status code" — which is exactly the generic failure the fail-loudly rule exists to prevent. The
 *  body carries the real reason, and these functions are written to put a sentence in it. */
/** The bearer an Edge Function is called with.
 *
 *  Passed explicitly rather than left to supabase-js to attach from its own session state: both
 *  functions verify the caller from this token, and a worker that has just woken and read its
 *  session out of `chrome.storage.local` is exactly the case where relying on an auth-state event
 *  to have fired is a coin toss. A missing bearer here is a 401 that reads as "you were signed
 *  out", which is the wrong sentence entirely. */
async function functionHeaders(): Promise<Record<string, string>> {
  const token = await accessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function refusalFrom(error: unknown, fallback: string): Promise<string> {
  const context = (error as { context?: Response }).context;
  if (context && typeof context.json === 'function') {
    try {
      const body = (await context.json()) as any;
      const message = body?.message ?? body?.error ?? body?.reason;
      if (typeof message === 'string' && message) return message;
    } catch {
      // A body that is not JSON tells us nothing the message below does not.
    }
  }
  return (error as { message?: string }).message || fallback;
}

/** Invite somebody.
 *
 *  `projectId: null` written explicitly is a *platform* invite — admins only, and consuming it
 *  creates a fresh project for the invitee. That is a different act from inviting into a project,
 *  and the two must not be conflated, so this signature makes the caller say which. */
export async function createInvite(email: string, projectId: string | null): Promise<InviteResult> {
  await requireSession();
  const address = email.trim();
  if (!address) return { status: 'refused', reason: 'enter an email address' };

  const { data, error } = await db().functions.invoke('invite', {
    body: { email: address, projectId },
    headers: await functionHeaders(),
  });
  if (error) return { status: 'refused', reason: await refusalFrom(error, 'the invite was refused') };
  if (!data || typeof data !== 'object') return { status: 'refused', reason: 'the invite function said nothing' };

  const body = data as any;
  switch (body.status) {
    case 'invited':
      return {
        status: 'invited',
        invite: toInvite(body.invite),
        userExisted: Boolean(body.userExisted),
        // Read straight through and never stored. The function minted it, the database holds only
        // its hash, and this reply is the one place it exists in the clear — a copy kept here would
        // be a copy that outlives the screen it is shown on.
        code: String(body.code ?? ''),
      };
    case 'at-capacity':
      return {
        status: 'at-capacity',
        headcount: {
          members: body.members ?? 0,
          pending: body.pending ?? 0,
          maxMembers: body.maxMembers ?? 0,
        },
      };
    case 'already-a-member':
      return { status: 'already-a-member' };
    case 'already-invited':
      return { status: 'already-invited' };
    default:
      return { status: 'refused', reason: body.reason ?? body.error ?? body.message ?? 'the invite was refused' };
  }
}

/** Revoking goes through the database function, because a client that can set `status` can set it
 *  to anything. This used to be a direct update under a policy that checked only membership, so a
 *  member could flip a pending invite to `accepted` — freeing a place against the six-person
 *  ceiling with nobody joining, repeatedly — or flip an expired one back to `pending`. Either makes
 *  `members + pending` stop meaning what `create_invite` takes an advisory lock to keep true. The
 *  function permits pending → revoked and nothing else. */
export async function revokeInvite(inviteId: string): Promise<void> {
  const { error } = await db().rpc('revoke_invite', { p_invite_id: inviteId });
  fail('revoking the invite', error);
}

/** Turn every live invite for the signed-in address into membership.
 *
 *  Call this immediately after a successful sign-in and before reading the session, because until
 *  it runs a newly invited person is a real account in no project at all — which the picker can
 *  only render as "you are not a member of any project yet". It takes no arguments: the function
 *  reads the caller and their address from the JWT, so there is nothing to point at somebody
 *  else's invite. Safe to call on every sign-in; it is a no-op when there is nothing pending. */
export async function consumeInvites(): Promise<void> {
  const { error } = await db().rpc('consume_invites');
  fail('joining the house hunt you were invited to', error);
}

/** Turn an invite code into an account, for somebody who has none.
 *
 *  The one call in this file that deliberately does NOT `requireSession()` first. Everything else
 *  here speaks for a signed-in person; this is the call somebody makes because they are not one
 *  yet, and requiring a session would make the invite flow impossible to start. What stands in for
 *  the session is the code, checked in the function against the address it was issued to, with the
 *  guess counted in the database — see `redeem_code` in the migration.
 *
 *  It does not sign anybody in. The account exists afterwards and the caller signs in on the
 *  ordinary path, which is what keeps `consume_invites()` running at exactly one moment in the
 *  system rather than at two. */
export async function redeemInvite(email: string, password: string, code: string): Promise<RedeemResult> {
  const address = email.trim().toLowerCase();
  if (!address) return { status: 'failed', message: 'enter the address you were invited on' };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { status: 'password-too-short', minimum: MIN_PASSWORD_LENGTH };
  }

  const { data, error } = await db().functions.invoke('password', {
    body: { action: 'redeem', email: address, password, code },
  });
  if (error) {
    // A 400 from the function is the length rule it enforces for real, and it is the one refusal
    // here the client could have prevented. Named rather than printed, so the field says what is
    // wrong with it instead of a banner saying something went wrong.
    const reason = await refusalFrom(error, 'that code could not be redeemed');
    if (/at least \d+ characters/i.test(reason)) {
      return { status: 'password-too-short', minimum: MIN_PASSWORD_LENGTH };
    }
    return { status: 'failed', message: reason };
  }

  const body = data as any;
  switch (body?.status) {
    case 'redeemed':
      return { status: 'redeemed' };
    case 'already-registered':
      return { status: 'already-registered' };
    case 'rate-limited':
      return { status: 'rate-limited', retryAfterSeconds: Number(body.retryAfterSeconds) || 3600 };
    case 'no-such-code':
      return { status: 'no-such-code' };
    default:
      return { status: 'failed', message: 'the invite function said nothing' };
  }
}

/** An admin setting somebody's password. Guarded in the Edge Function, which checks the caller's
 *  `is_admin` against the database rather than trusting this call site — hiding the button is
 *  presentation, and the boundary is on the other side of the wire. */
export async function adminSetPassword(userId: string, password: string): Promise<void> {
  await requireSession();
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`a password of at least ${MIN_PASSWORD_LENGTH} characters is required`);
  }
  const { error } = await db().functions.invoke('password', {
    body: { action: 'reset', userId, password },
    headers: await functionHeaders(),
  });
  if (error) throw new Error(await refusalFrom(error, 'the password was not changed'));
}

/** Resending is a fresh invite for the same address: the Edge Function is the only thing that may
 *  extend an expiry, and a revoke-then-invite is the shape it already validates. It also mints a
 *  new code, which is the answer to "they lost it" — there is no way to read the old one back. */
export async function resendInvite(inviteId: string): Promise<InviteResult> {
  const { data, error } = await db()
    .from('invite')
    .select('email, project_id')
    .eq('id', inviteId)
    .maybeSingle();
  fail('reading the invite to resend', error);
  if (!data) return { status: 'refused', reason: 'that invite no longer exists' };
  await revokeInvite(inviteId);
  return createInvite(data.email as string, (data.project_id as string | null) ?? null);
}

/** One neighbourhood name to the identifier Rightmove searches it by.
 *
 *  NO-CRAWL, restated at the call site because this is exactly the kind of thing that looks like
 *  precedent later: this is one request, made because one person is adding one hub, and it is the
 *  same single hand-run lookup `pnpm find:locations` performs today. Nothing here enumerates,
 *  nothing here runs in the background, and nothing here may be moved onto a loop. The standing
 *  rule in AGENTS.md is unchanged. */
export async function resolveLocation(name: string): Promise<LocationResult> {
  await requireSession();
  const { data, error } = await db().functions.invoke('resolve-location', {
    body: { query: name },
    headers: await functionHeaders(),
  });
  if (error) return { status: 'failed', message: await refusalFrom(error, 'could not resolve that neighbourhood') };

  const body = data as any;
  if (body?.status === 'resolved') {
    return {
      status: 'resolved',
      slug: body.slug,
      locationIdentifier: body.locationIdentifier,
      // The function calls it `displayLocationId`; hubs.ts and the sweep URL builder have always
      // called it `displayLocationIdentifier`, and renaming it at the boundary is cheaper than two
      // names for one string travelling through five files.
      displayLocationIdentifier: body.displayLocationId,
      displayName: body.displayName ?? name,
      centroid: body.centroid ?? null,
    };
  }
  if (body?.status === 'not-found') return { status: 'not-found', slug: body.slug ?? name };
  if (body?.status === 'rate-limited') {
    return {
      status: 'rate-limited',
      used: body.used ?? 0,
      limit: body.limit ?? 0,
      retryAfterSeconds: body.retry_after_seconds ?? 3600,
    };
  }
  return { status: 'failed', message: body?.message ?? 'could not resolve that neighbourhood' };
}

// ------------------------------------------------------------------------------------------------
// Spend.
// ------------------------------------------------------------------------------------------------

export async function spendSummary(): Promise<SpendSummary> {
  const session = await requireSession();
  const projectId = await activeProjectId();
  const { data, error } = await db().rpc('spend_summary', {
    p_project_id: projectId,
    p_user_id: session.user.id,
  });
  fail('reading this month\'s spend', error);
  const body = data as any;
  if (!body || body.error) throw new Error(`reading this month's spend: ${body?.error ?? 'no answer'}`);
  return {
    project: {
      spentUsd: Number(body.project_spent ?? 0),
      capUsd: Number(body.project_cap ?? 0),
      resetsAt: body.resets_at,
    },
    user: {
      spentUsd: Number(body.user_spent ?? 0),
      capUsd: Number(body.user_cap ?? 0),
      resetsAt: body.resets_at,
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Admin. Hiding the tab is presentation; RLS is the boundary — every query here returns only the
// caller's own rows for a non-admin, which is why none of it is gated on `is_admin` in the client.
// ------------------------------------------------------------------------------------------------

function monthStartIso(): string {
  // Europe/London, matching `month_start_london()` in the database and every other date here.
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = parts.find((p) => p.type === 'year')!.value;
  const month = parts.find((p) => p.type === 'month')!.value;
  return new Date(`${year}-${month}-01T00:00:00Z`).toISOString();
}

/** How many usage rows to ask for at a time.
 *
 *  PostgREST caps a response at its `max-rows` setting — 1000 on Supabase — and says so nowhere in
 *  the reply: a select with no range comes back looking like the whole answer. Every figure on the
 *  Admin screen is summed from these rows in the browser, so the month's charges quietly stopped at
 *  the thousandth and the page showed less money than had been spent, while the warning banner —
 *  which sums in SQL, where no such cap exists — showed the real figure. Two numbers for one fact,
 *  and the wrong one was the one with the table under it. */
const USAGE_PAGE = 1000;

/** Walked by the key rather than by an offset, because the thing being read is still being written
 *  to. `range(1000, 1999)` is a second query against a table that may have gained a row since the
 *  first, and every offset after the insert shifts by one — so the boundary row is read twice and
 *  summed twice, on a screen whose whole job is to say how much has been spent. `id` is a bigint
 *  identity, so it is unique and always ascending: a row written mid-read gets a *higher* id, which
 *  places it before everything already seen rather than in the middle of what has not been.
 *
 *  Ordered on the key for the same reason. `occurred_at` is what the answer is sorted by, and that
 *  is done below, once the whole set is here. */
async function usageSince(since: string): Promise<UsageRow[]> {
  const rows: Array<Record<string, unknown>> = [];
  let before: number | null = null;
  for (;;) {
    const { data, error } = await db()
      .from('api_usage')
      .select('id, occurred_at, project_id, user_id, kind, model, input_tokens, cached_input_tokens, output_tokens, cost_usd, rightmove_id')
      .gte('occurred_at', since)
      // No id is ever this high — a bigint identity would have to be handed out at a million a
      // second for three hundred years — so the first page is the one with no cursor yet.
      .lt('id', before ?? Number.MAX_SAFE_INTEGER)
      .order('id', { ascending: false })
      .limit(USAGE_PAGE);
    fail('reading spend', error);
    const got: Array<Record<string, unknown>> = data ?? [];
    rows.push(...got);
    if (got.length < USAGE_PAGE) break;
    before = Number(got.at(-1)!.id);
  }
  return (rows as any[])
    .sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)) || Number(b.id) - Number(a.id))
    .map((r) => ({
      id: String(r.id),
      occurredAt: r.occurred_at,
      projectId: r.project_id ?? null,
      userId: r.user_id ?? null,
      kind: r.kind,
      model: r.model ?? '',
      inputTokens: r.input_tokens,
      cachedInputTokens: r.cached_input_tokens,
      outputTokens: r.output_tokens,
      costUsd: Number(r.cost_usd),
      rightmoveId: r.rightmove_id ?? null,
    }));
}

export async function adminUsage(filter: { projectId?: string; userId?: string; since?: string }): Promise<UsageRow[]> {
  const rows = await usageSince(filter.since ?? monthStartIso());
  return rows.filter(
    (r) => (!filter.projectId || r.projectId === filter.projectId) && (!filter.userId || r.userId === filter.userId),
  );
}

export async function adminUsers(): Promise<AdminUser[]> {
  const { data, error } = await db()
    .from('profile')
    .select('id, email, display_name, is_admin, monthly_cap_usd, created_at, last_seen_at')
    .order('created_at');
  fail('reading users', error);

  const { data: memberships, error: memberError } = await db()
    .from('project_member')
    .select('user_id, project:project_id (id, name)');
  fail('reading memberships', memberError);

  const usage = await usageSince(monthStartIso());
  const spentByUser = new Map<string, number>();
  for (const row of usage) {
    if (!row.userId) continue;
    spentByUser.set(row.userId, (spentByUser.get(row.userId) ?? 0) + row.costUsd);
  }

  const projectsByUser = new Map<string, Array<{ id: string; name: string }>>();
  for (const row of (memberships ?? []) as any[]) {
    const project = Array.isArray(row.project) ? row.project[0] : row.project;
    if (!project) continue;
    const list = projectsByUser.get(row.user_id) ?? [];
    list.push({ id: project.id, name: project.name });
    projectsByUser.set(row.user_id, list);
  }

  return ((data ?? []) as any[]).map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.display_name?.trim() || r.email,
    isAdmin: r.is_admin,
    monthlyCapUsd: Number(r.monthly_cap_usd),
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at ?? null,
    projects: projectsByUser.get(r.id) ?? [],
    spentThisMonthUsd: spentByUser.get(r.id) ?? 0,
  }));
}

export async function adminProjects(): Promise<AdminProject[]> {
  const { data, error } = await db()
    .from('project')
    .select('id, name, monthly_cap_usd, max_members, created_at, project_member(count), project_property(count)')
    .order('created_at');
  fail('reading projects', error);

  const usage = await usageSince(monthStartIso());
  const spentByProject = new Map<string, number>();
  for (const row of usage) {
    if (!row.projectId) continue;
    spentByProject.set(row.projectId, (spentByProject.get(row.projectId) ?? 0) + row.costUsd);
  }

  return ((data ?? []) as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    memberCount: r.project_member?.[0]?.count ?? 0,
    propertyCount: r.project_property?.[0]?.count ?? 0,
    monthlyCapUsd: Number(r.monthly_cap_usd),
    maxMembers: r.max_members,
    createdAt: r.created_at,
    spentThisMonthUsd: spentByProject.get(r.id) ?? 0,
  }));
}

export async function adminSetUserCap(userId: string, capUsd: number): Promise<void> {
  const { error } = await db().rpc('admin_set_user_cap', { p_user_id: userId, p_cap: capUsd });
  fail('changing a personal cap', error);
}

export async function adminSetProjectCap(projectId: string, capUsd: number): Promise<void> {
  const { error } = await db().rpc('admin_set_project_cap', { p_project_id: projectId, p_cap: capUsd });
  fail('changing a project cap', error);
}

export async function adminSetMaxMembers(projectId: string, maxMembers: number): Promise<void> {
  const { error } = await db().rpc('admin_set_max_members', { p_project_id: projectId, p_max: maxMembers });
  fail('changing the member limit', error);
}
