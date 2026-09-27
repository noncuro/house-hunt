"""Synthesise a cut's soundtrack, timed to its scenes in src/cuts.json.

One arrangement, `upbeat`, fitted to each cut: 120 bpm, a kick under every cut of the opening
montage, a riser into the title, the full kit from there. Everything is generated here — no samples, no licensed music — so the video can sit in a
public repo.

    pnpm music        # every cut: public/music-60.wav, public/music-45.wav
    pnpm music 45     # one cut
"""

import json
import sys
import wave
from pathlib import Path

import numpy as np
from scipy.signal import butter, fftconvolve, sosfilt
from tqdm import tqdm

SR = 48_000
FPS = 30
HERE = Path(__file__).resolve().parent.parent
CUTS = json.loads((HERE / "src" / "cuts.json").read_text())

rng = np.random.default_rng(7)


def hz(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def scene_starts(cut: str) -> tuple[dict[str, float], float]:
    """When each scene begins, in seconds, and how long the cut runs."""
    spec = CUTS[cut]
    starts, frame = {}, 0
    for name, frames in spec["scenes"].items():
        starts[name] = frame / FPS
        frame += frames - spec["fade"]
    return starts, (frame + spec["fade"]) / FPS


class Song:
    BUSES = ("keys", "pad", "bass", "drums", "fx")

    def __init__(self, length: float):
        self.length = length
        self.n = int(SR * length)
        self.bus = {name: np.zeros((2, self.n)) for name in self.BUSES}

    def place(self, sig: np.ndarray, start: float, pan: float = 0.0, gain: float = 1.0, to: str = "keys", human: bool = True) -> None:
        """Add a voice to a bus. Played notes are humanised: a few ms late or early, a little louder or softer."""
        if human:
            start += rng.normal(0, 0.006)
            gain *= rng.uniform(0.85, 1.1)
        i = max(0, int(start * SR))
        if i >= self.n:
            return
        sig = sig[: self.n - i] * gain
        target = self.bus[to]
        target[0, i : i + sig.size] += sig * np.cos((pan + 1) * np.pi / 4)
        target[1, i : i + sig.size] += sig * np.sin((pan + 1) * np.pi / 4)


# --- voices -----------------------------------------------------------------------------------


def epiano(midi: float, dur: float, vel: float = 0.6, decay: float = 1.0, bright: float = 0.9) -> np.ndarray:
    """A two-operator FM tine, the usual route to a Rhodes-like voice. More `bright` and more
    `decay` turn it into a pluck."""
    n = int((dur + 1.8) * SR)
    t = np.arange(n) / SR
    f = hz(midi)
    mod = np.sin(2 * np.pi * f * t) * bright * vel * np.exp(-t * 4.0 * decay)
    tone = np.sin(2 * np.pi * f * t + mod)
    tone += 0.08 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t * 5)
    tone += 0.35 * np.sin(2 * np.pi * f * 1.003 * t + mod * 0.8)  # a touch of chorus
    env = np.minimum(1, t / 0.006) * np.exp(-t * (1.1 + midi / 90) * decay)
    return tone * env * np.clip(1 - (t - dur) / 0.35, 0, 1) * vel * 0.22


def pad(midis: list[int], dur: float, attack: float = 1.2) -> np.ndarray:
    n = int((dur + 1.5) * SR)
    t = np.arange(n) / SR
    sig = np.zeros(n)
    for m in midis:
        f = hz(m)
        for det in (-0.004, 0.0, 0.005):
            for h, a in ((1, 1.0), (2, 0.35), (3, 0.12)):
                sig += a * np.sin(2 * np.pi * f * h * (1 + det) * t + rng.uniform(0, 6.28))
    env = np.minimum(1, t / attack) * np.clip(1 - (t - dur) / 1.5, 0, 1)
    return sig * env * 0.012


def bass(midi: int, dur: float, decay: float = 1.4) -> np.ndarray:
    n = int((dur + 0.3) * SR)
    t = np.arange(n) / SR
    f = hz(midi)
    sig = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(2 * np.pi * 2 * f * t)
    env = np.minimum(1, t / 0.012) * np.exp(-t * decay) * np.clip(1 - (t - dur) / 0.3, 0, 1)
    return sig * env * 0.16


def hat(vel: float, open_: bool = False) -> np.ndarray:
    n = int((0.25 if open_ else 0.09) * SR)
    t = np.arange(n) / SR
    noise = sosfilt(butter(2, 7000, "highpass", fs=SR, output="sos"), rng.standard_normal(n))
    return noise * np.exp(-t * (14 if open_ else 60)) * 0.018 * vel


def kick() -> np.ndarray:
    """A pitched-down sine with a sub under it and a click on top, driven for punch."""
    n = int(0.5 * SR)
    t = np.arange(n) / SR
    freq = 52 + 130 * np.exp(-t * 28)
    body = np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-t * 6)
    sub = np.sin(2 * np.pi * 50 * t) * np.exp(-t * 5) * np.minimum(1, t / 0.01) * 0.6
    click = sosfilt(butter(2, 2500, "highpass", fs=SR, output="sos"), rng.standard_normal(n)) * np.exp(-t * 300) * 0.35
    return np.tanh((body + sub + click) * 2.0) * 0.55


def clap() -> np.ndarray:
    n = int(0.3 * SR)
    t = np.arange(n) / SR
    noise = sosfilt(butter(2, [900, 4000], "bandpass", fs=SR, output="sos"), rng.standard_normal(n))
    env = np.exp(-t * 22)
    for k in (0.0, 0.011, 0.022):  # three hands, a few ms apart
        env += np.where(t >= k, np.exp(-(t - k) * 180), 0) * 0.8
    # A snare under the clap: a tuned body and a brighter rattle, so it cuts through the pads.
    body = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 30) * 0.5
    rattle = sosfilt(butter(2, 5000, "highpass", fs=SR, output="sos"), rng.standard_normal(n)) * np.exp(-t * 28) * 0.5
    return (noise * env + body + rattle) * 0.13


def riser(dur: float) -> np.ndarray:
    """Noise swept up through a band-pass: the breath before the drop."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    out = np.zeros(n)
    steps = 24
    for k in range(steps):
        lo, hi = k * n // steps, (k + 1) * n // steps
        centre = 400 * (12000 / 400) ** (k / steps)
        band = sosfilt(butter(2, [centre * 0.7, min(centre * 1.4, 20000)], "bandpass", fs=SR, output="sos"), noise)
        out[lo:hi] = band[lo:hi]
    return out * (t / dur) ** 2 * 0.08


# F major. Each chord: bass root, voicing for the piano.
CHORDS = {
    "Fmaj7": (41, [57, 60, 64, 65]),
    "Am7": (45, [57, 60, 64, 67]),
    "Dm7": (38, [57, 60, 62, 65]),
    "Bbmaj7": (46, [57, 58, 62, 65]),
    "Gm7": (43, [58, 62, 65, 67]),
    "Csus": (48, [58, 60, 65, 67]),
    "Fmaj9": (41, [57, 60, 64, 67, 69]),
}


# --- arrangements -----------------------------------------------------------------------------


def upbeat(song: Song, scenes: dict[str, float]) -> list[float]:
    """120 bpm, vi–IV–I–V. A plucked arpeggio, hats and a kick on every beat under the montage, a
    snare roll and a riser into the title, the full kit from there, a lift at the verdict, and a stop
    on the end card.

    Returns the kick times, which the mix ducks the pads and keys around."""
    beat = 60 / 120
    bar = 4 * beat
    # The title fades in over the montage's last frames; the drop is the next downbeat, which the
    # montage is timed to land on.
    title = float(np.ceil(scenes["Title"] / bar) * bar)
    end, lift = scenes["End"], scenes["Verdict"]
    kicks: list[float] = []

    loop = ["Dm7", "Bbmaj7", "Fmaj7", "Csus"]
    lifted = ["Bbmaj7", "Csus", "Dm7", "Fmaj7"]
    arp = [0, 1, 2, 3, 2, 1, 3, 2, 0, 1, 2, 3, 2, 3, 1, 2]  # sixteenths
    bars = int(np.ceil(end / bar))

    for b in tqdm(range(bars), desc="upbeat"):
        start = b * bar
        name = (lifted if start >= lift - 0.1 and start < end - 2 * bar else loop)[b % 4]
        root, voicing = CHORDS[name]
        drop = start >= title - 0.05
        if drop and start < end:
            song.place(bass(root - 12, bar * 0.95, decay=0.6), start, gain=0.9, to="bass", human=False)
        lifted_bar = lift - 0.1 <= start < end - 2 * bar
        if start + bar > lift - 0.1 > start or start + bar == title:
            # A snare roll across the bar before the title and the lift: eighths, then sixteenths,
            # getting louder.
            for k in range(16):
                if k >= 8 or k % 2 == 0:
                    song.place(clap(), start + k * beat / 4, gain=0.35 + 0.65 * k / 15, pan=0.1, to="drums")
            if start + bar != title:  # the title has its own, longer riser
                song.place(riser(bar), start, gain=0.8, to="fx", human=False)
        if lifted_bar:
            # The lift: a counter-melody on top and a sparkle an octave above the arpeggio.
            for k, idx in enumerate([3, 2, 3, 1]):
                song.place(epiano(voicing[idx] + 24, beat * 0.9, 0.3, decay=0.9, bright=1.2), start + k * beat, pan=0.15)
            for step in range(0, 16, 2):
                song.place(epiano(voicing[arp[step]] + 24, beat * 0.15, 0.14, decay=3.0, bright=2.0), start + step * beat / 4 + beat / 4, pan=0.5 if step % 4 else -0.5)

        song.place(pad([v - 12 for v in voicing[:3]] + [voicing[3], voicing[1] + 12], bar, attack=0.05), start, gain=0.5 if drop else 0.4, to="pad", human=False)
        for step, idx in enumerate(arp):
            at = start + step * beat / 4
            if at >= end:
                break
            if not drop and step % 2:
                continue  # eighths before the drop, sixteenths after
            vel = 0.36 if step % 4 == 0 else 0.26
            song.place(epiano(voicing[idx] + 12, beat * 0.2, vel, decay=2.6, bright=1.8), at, pan=-0.3 if step % 2 else 0.3)
        for k in range(8):
            at = start + k * beat / 2
            if at >= end:
                break
            song.place(bass(root + (12 if k % 2 else 0), beat * 0.45, decay=3), at, gain=1.6 if drop else 0.8, to="bass")
            song.place(hat(0.9 if k % 2 else 0.5, open_=drop and k % 2 == 1), at, gain=3.5, pan=0.25, to="drums")
        for k in range(4):
            at = start + k * beat
            if at >= end:
                break
            if drop or at < title:
                song.place(kick(), at, gain=1.0 if drop or k == 0 else 0.75, to="drums", human=False)
                kicks.append(at)
            if drop and k % 2:
                song.place(clap(), at, pan=-0.05, to="drums")
            if drop:
                song.place(hat(0.6), at + beat / 4, gain=3.0, pan=-0.25, to="drums")
                song.place(hat(0.45), at + 3 * beat / 4, gain=3.0, pan=-0.25, to="drums")
            if lifted_bar:  # a shaker on every sixteenth once the lift has come
                for q in range(4):
                    song.place(hat(0.5 if q % 2 else 0.3), at + q * beat / 4, gain=2.0, pan=0.55, to="drums")

    # The breath before the title, and the hit on it.
    song.place(riser(title - 1.6 if title > 1.6 else title), 1.6 if title > 1.6 else 0, to="fx", human=False)
    for k, m in enumerate(CHORDS["Dm7"][1]):
        song.place(epiano(m + 12, 0.6, 0.4, bright=1.4), title + k * 0.01, pan=-0.3 + k * 0.2, to="fx")
    # Short whooshes into each chapter.
    for name in ("Sweeps", "Travel", "Photos", "Verdict", "Triage", "Shortlist", "Everywhere"):
        if name in scenes:
            song.place(riser(0.5), scenes[name] - 0.5, gain=0.5, to="fx", human=False)
    # The end: the drums stop and one chord rings.
    root, voicing = CHORDS["Fmaj9"]
    song.place(kick(), end, to="drums", human=False)
    kicks.append(end)
    song.place(bass(root, 3.0, decay=0.8), end, to="bass")
    song.place(pad([v - 12 for v in voicing[:3]] + voicing[3:], 3.0, attack=0.02), end, gain=1.6, to="pad", human=False)
    for k, v in enumerate(voicing):
        song.place(epiano(v + 12, 3.0, 0.42, decay=0.35), end + k * 0.03, pan=-0.3 + k * 0.15, to="fx")
    # Echoes of the top note, left and right, to carry the chord to the last frame.
    for k in range(1, 6):
        song.place(epiano(voicing[-1] + 24, 0.4, 0.3 * 0.7**k, decay=1.5), end + k * 0.375, pan=-0.6 if k % 2 else 0.6, to="fx", human=False)
    return kicks


# --- mix --------------------------------------------------------------------------------------


def filt(x: np.ndarray, kind: str, freq, order: int = 2) -> np.ndarray:
    return sosfilt(butter(order, freq, kind, fs=SR, output="sos"), x, axis=1)


def peak_cut(x: np.ndarray, f0: float, db: float, q: float = 1.0) -> np.ndarray:
    """A simple peaking cut: subtract a band-passed copy."""
    bw = f0 / q
    return x - filt(x, "bandpass", [f0 - bw / 2, f0 + bw / 2]) * (1 - 10 ** (db / 20))


def ducking(n: int, kicks: list[float], depth: float = 0.7, release: float = 0.16) -> np.ndarray:
    """A gain curve that dips on every kick and recovers: the pump that makes a groove breathe."""
    gain = np.ones(n)
    t = np.arange(int(release * 5 * SR)) / SR
    dip = 1 - depth * np.exp(-t / release) * np.minimum(1, t / 0.004 + 0.2)
    for at in kicks:
        i = int(at * SR)
        j = min(n, i + dip.size)
        gain[i:j] = np.minimum(gain[i:j], dip[: j - i])
    return gain


def mixdown(song: Song, kicks: list[float]) -> np.ndarray:
    b = song.bus
    # Each part gets its own room: the bass owns the bottom, the keys lose their boxiness and their
    # glassy top, the pad sits above the bass rather than on it.
    keys = peak_cut(filt(b["keys"], "highpass", 140), 280, -4)
    keys = peak_cut(filt(keys, "lowpass", 6000), 3000, -1.5)
    pad_ = filt(filt(b["pad"], "highpass", 200), "lowpass", 4000)
    bass_ = filt(b["bass"], "lowpass", 600)
    drums = filt(b["drums"], "highpass", 30) * 1.3
    fx = filt(b["fx"], "lowpass", 9000)

    pump = ducking(song.n, kicks)
    keys, pad_, bass_ = keys * pump * 0.6, pad_ * pump, bass_ * (0.5 + 0.5 * pump)

    mix = keys + pad_ + bass_ + drums
    send = keys * 0.9 + pad_ * 0.6 + fx * 1.3 + drums * 0.15

    ir_len = int(2.4 * SR)
    ir_t = np.arange(ir_len) / SR
    wet = np.zeros_like(mix)
    for ch in range(2):  # a plate-ish reverb: decaying stereo noise as the impulse response
        ir = sosfilt(butter(1, 5500, "lowpass", fs=SR, output="sos"), rng.standard_normal(ir_len) * np.exp(-ir_t * 3.5))
        wet[ch] = fftconvolve(send[ch], ir / np.sqrt(np.sum(ir**2)))[: song.n]
    out = mix * 0.8 + fx * 0.5 + wet * 0.3

    out = filt(filt(out, "lowpass", 14000), "highpass", 35)
    t = np.arange(song.n) / SR
    out *= np.minimum(1, t / 0.02) * np.clip((song.length - t) / 1.5, 0, 1) ** 1.5

    # Soft-knee limit, driven: this is meant to be heard, not to sit under the picture.
    out = np.tanh(out * 1.5) / 1.5
    return out * 10 ** (-2.3 / 20) / np.max(np.abs(out))


def render(cut: str) -> Path:
    scenes, length = scene_starts(cut)
    song = Song(length)
    out = mixdown(song, upbeat(song, scenes))
    print(f"{cut}: {length:.1f}s, rms {20 * np.log10(np.sqrt(np.mean(out**2))):.1f} dBFS")

    path = HERE / "public" / f"music-{cut}.wav"
    path.parent.mkdir(exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((out.T * 32767).astype(np.int16).tobytes())
    return path


if __name__ == "__main__":
    for cut in sys.argv[1:] or [c for c in CUTS if not c.startswith("/")]:
        print(render(cut))
