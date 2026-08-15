import { createRoot, type Root } from 'react-dom/client';
import { Sweep } from './Sweep';
import { send } from '@/lib/messages';
/* First, so everything after it can read a token. This shadow root has no page stylesheet to
   inherit them from either — see the note on `:host` in tokens.css. */
import '@house-hunt/ui/tokens.css';
import './style.css';

/** The sweep panel, on search-results pages only.
 *
 *  A second content script on pages `search.content` also runs on, and deliberately so: that one
 *  decorates cards with verdicts and has nothing to do with sweeping, and merging them would give
 *  one script two reasons to change. They share `lib/cards.ts` so they cannot disagree about what
 *  a card is.
 *
 *  Only `find.html`. `search.content` also covers saved lists and the map view, where a "sweep"
 *  makes no sense — there is no search behind them to be finished, and `__NEXT_DATA__` on those
 *  pages holds something else entirely. */
export default defineContentScript({
  matches: ['https://www.rightmove.co.uk/property-to-rent/find.html*'],
  cssInjectionMode: 'ui',

  async main(ctx) {
    // Absent entirely when nobody is signed in, or when no project is chosen (design D13). A
    // sweep is a project's progress through a project's neighbourhoods; with no project there is
    // nothing for it to be the progress of, and every message it sends would be refused. The
    // card styles go in after the gate so a signed-out page is left exactly as Rightmove built it.
    const auth = await send({ type: 'auth:state' });
    if (!auth.ok || auth.data.status !== 'signed-in' || !auth.data.activeProject) return;

    injectCardStyles();

    const ui = await createShadowRootUi(ctx, {
      name: 'rightmove-sweep',
      position: 'inline',
      anchor: 'body',
      onMount(container): Root {
        const root = createRoot(container);
        root.render(<Sweep />);
        return root;
      },
      onRemove(root) {
        root?.unmount();
      },
    });
    ui.mount();
  },
});

/** Rules that restyle Rightmove's own cards, which therefore cannot live in the shadow root the
 *  panel renders into. Every selector is namespaced so nothing of theirs is touched by accident,
 *  and this is a handful of rules rather than a stylesheet — the marks are a border and a
 *  `display: none`, and keeping them here puts them next to the attribute that drives them. */
function injectCardStyles(): void {
  const style = document.createElement('style');
  style.textContent = `
    [data-rm-sweep="complete"] { opacity: 0.55; }
    [data-rm-sweep="partial"] {
      outline: 2px dashed #c98a2b;
      outline-offset: -2px;
      border-radius: 8px;
    }
    /* Hiding, not removing: the toggle has to be reversible, and Rightmove's own grid copes with
       a hidden child where it would not cope with a detached one. */
    body.rm-sweep-hiding [data-rm-sweep="complete"] { display: none !important; }
  `;
  document.head.append(style);
}
