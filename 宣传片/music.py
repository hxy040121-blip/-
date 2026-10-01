#!/usr/bin/env python3
"""《夙与愿》宣传片配乐与音效。

全部由代码合成，不使用任何采样。节拍与画面共用 timeline.json，
所以每一个钟声、关门、打字音都落在画面对应的那一拍上。

用法：python3 music.py [输出路径]   （默认 build/music.wav，48 kHz 立体声）
"""
import json
import os
import re
import sys
import wave

import numpy as np
from scipy import signal
from scipy.ndimage import minimum_filter1d, uniform_filter1d

SR = 48000
HERE = os.path.dirname(os.path.abspath(__file__))
REL = ("b", "until", "decodeEnd", "inB", "flipB", "tagB", "fadeB", "coinGone", "appear", "coinsAppear")


def load_timeline():
    """读 timeline.json，把带 sec 的条目从段内相对拍数换算成绝对拍数（与 scene.js 相同）。"""
    tl = json.load(open(os.path.join(HERE, "timeline.json"), encoding="utf-8"))
    start, secs, pos = {}, {}, 0
    for name, ln in tl["sections"]:
        start[name], secs[name] = pos, [pos, pos + ln]
        pos += ln
    tl["sections"], tl["totalBeats"] = secs, pos

    def walk(o):
        if isinstance(o, list):
            for v in o:
                walk(v)
        elif isinstance(o, dict):
            if isinstance(o.get("sec"), str):
                base = start[o["sec"]]
                for k in REL:
                    if isinstance(o.get(k), (int, float)):
                        o[k] += base
                if isinstance(o.get("times"), list):
                    o["times"] = [t + base for t in o["times"]]
            for v in o.values():
                walk(v)
    walk(tl)
    return tl


TL = load_timeline()
BEAT = 60.0 / TL["bpm"]
TOTAL_BEATS = TL["totalBeats"]
N = int((TOTAL_BEATS * BEAT + 1.0) * SR)
rng = np.random.default_rng(20261001)


def tb(b):
    return b * BEAT


# ---------------------------------------------------------------- 音高

_PC = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6,
       "Gb": 6, "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11}


def midi(name):
    m = re.fullmatch(r"([A-G][#b]?)(-?\d)", name)
    return 12 * (int(m.group(2)) + 1) + _PC[m.group(1)]


def hz(x):
    if isinstance(x, str):
        x = midi(x)
    return 440.0 * 2 ** ((x - 69) / 12)


CHORDS = {
    "Dm": ["D4", "F4", "A4", "D5"],
    "Bb": ["Bb3", "D4", "F4", "Bb4"],
    "Gm": ["G3", "Bb3", "D4", "G4"],
    "A": ["A3", "C#4", "E4", "A4"],
    "C": ["C4", "E4", "G4", "C5"],
}
ROOTS = {"Dm": "D2", "Bb": "Bb1", "Gm": "G1", "A": "A1", "C": "C2"}

# 主题动机（八音盒）：(拍内偏移, 音, 时值)
THEME = [(0, "D5", 1), (1, "A4", .5), (1.5, "F5", .5), (2, "E5", 1), (3, "C#5", 1),
         (4, "D5", 1.5), (5.5, "E5", .5), (6, "F5", .5), (6.5, "E5", .5), (7, "Bb4", 1),
         (8, "A4", 1), (9, "D5", .5), (9.5, "F5", .5), (10, "A5", 1), (11, "G5", .5), (11.5, "F5", .5),
         (12, "E5", 1), (13, "C#5", 1), (14, "D5", 2)]


# ---------------------------------------------------------------- 包络与工具

def tarr(dur):
    return np.arange(int(dur * SR)) / SR


def ar(n, a, r):
    e = np.ones(n)
    na, nr = max(1, int(a * SR)), max(1, int(r * SR))
    na, nr = min(na, n), min(nr, n)
    e[:na] *= np.linspace(0, 1, na)
    e[n - nr:] *= np.linspace(1, 0, nr)
    return e


def sos(kind, f, order=2):
    return signal.butter(order, f, kind, fs=SR, output="sos")


def filt(x, kind, f, order=2):
    return signal.sosfilt(sos(kind, f, order), x, axis=0)


def mix(*xs):
    """把长度不同的单声道信号叠在一起。"""
    n = max(len(x) for x in xs)
    out = np.zeros(n)
    for x in xs:
        out[:len(x)] += x
    return out


def norm(x, peak=1.0):
    m = np.max(np.abs(x)) + 1e-12
    return x / m * peak


def seat_pan(seat):
    """一号席在正北，顺时针排列；声像取席位的横坐标。"""
    ang = -np.pi / 2 + (seat - 1) * 2 * np.pi / 15
    return float(np.cos(ang)) * 0.7


# ---------------------------------------------------------------- 混音台

class Mixer:
    def __init__(self):
        # post 不经过静音区与混响，用来放静场里仍要听见的心跳、底噪
        self.bus = {k: np.zeros((N, 2)) for k in ("drums", "music", "sfx", "pad", "post")}
        self.mutes = []
        self.hall = np.zeros((N, 2))
        self.room = np.zeros((N, 2))
        self.kicks = []

    def add(self, bus, t, x, gain=1.0, pan=0.0, hall=0.0, room=0.0):
        if x.ndim == 1:
            th = (np.clip(pan, -1, 1) + 1) * np.pi / 4
            x = np.stack([x * np.cos(th), x * np.sin(th)], 1) * np.sqrt(2)
        i = int(round(t * SR))
        if i >= N:
            return
        if i < 0:
            x, i = x[-i:], 0
        n = min(len(x), N - i)
        seg = x[:n] * gain
        self.bus[bus][i:i + n] += seg
        if hall:
            self.hall[i:i + n] += seg * hall
        if room:
            self.room[i:i + n] += seg * room


MX = Mixer()


# ---------------------------------------------------------------- 音色

def musicbox(f, dur=3.2):
    t = tarr(dur)
    x = np.sin(2 * np.pi * f * t) * np.exp(-t / 1.2)
    x += 0.30 * np.sin(2 * np.pi * f * 2.0 * t + .3) * np.exp(-t / .5)
    x += 0.16 * np.sin(2 * np.pi * f * 5.4 * t) * np.exp(-t / .10)
    x += 0.07 * np.sin(2 * np.pi * f * 8.9 * t) * np.exp(-t / .04)
    nc = int(.004 * SR)
    x[:nc] += rng.standard_normal(nc) * np.linspace(.25, 0, nc)
    return x * ar(len(t), .001, .08)


def bell(f, dur=10.0):
    t = tarr(dur)
    x = np.zeros_like(t)
    for r, a, d in [(.5, 1.0, 4.5), (1, .8, 3.2), (1.19, .55, 2.4), (1.5, .4, 2.0), (2, .6, 1.6),
                    (2.51, .3, 1.1), (2.66, .25, .9), (3.01, .25, .7), (4.1, .14, .45), (5.4, .09, .25)]:
        for det in (-.55, .55):
            x += a * .5 * np.sin(2 * np.pi * (f * r + det) * t + rng.uniform(0, 6.28)) * np.exp(-t / d)
    nc = int(.012 * SR)
    x[:nc] += filt(rng.standard_normal(nc), "low", 4000) * np.linspace(1, 0, nc)
    return x * ar(len(t), .001, .5)


def saw_voice(f, dur, nh=32, bright=None, vib=0.0, vib_rate=5.5, drift=0.0):
    """加法合成锯齿波。bright(k, t) 给出第 k 次谐波的幅度系数。"""
    t = tarr(dur)
    fr = f * (1 + vib * np.sin(2 * np.pi * vib_rate * t + rng.uniform(0, 6.28))
              + drift * np.sin(2 * np.pi * .08 * t + rng.uniform(0, 6.28)))
    ph = 2 * np.pi * np.cumsum(fr) / SR
    out = np.zeros_like(t)
    nh = int(min(nh, (SR * .45) // (f * 1.05)))
    for k in range(1, nh + 1):
        a = 1.0 / k
        if bright is not None:
            a = a * bright(k, t)
        out += a * np.sin(k * ph + rng.uniform(0, 6.28))
    return out


def drone(f, dur, voices=3, nh=24, soft=7.0):
    out = np.zeros(int(dur * SR))
    for v in range(voices):
        det = f * (1 + (v - (voices - 1) / 2) * .0045)
        out += saw_voice(det, dur, nh=nh, bright=lambda k, t: np.exp(-(k - 1) / soft), drift=.002)
    return filt(out / voices, "high", 45)


def pad(notes, dur, soft=4.0, a=1.5, r=2.0, vib=.003):
    out = np.zeros(int(dur * SR))
    for nme in notes:
        for d in (-.004, .004):
            out += saw_voice(hz(nme) * (1 + d), dur, nh=20, bright=lambda k, t: np.exp(-(k - 1) / soft),
                             vib=vib, vib_rate=4.8)
    return out / (2 * len(notes)) * ar(len(out), a, r)


def kick(f0=150, f1=42, dur=.5, tau=.28):
    t = tarr(dur)
    fr = f1 + (f0 - f1) * np.exp(-t / .04)
    x = np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.exp(-t / tau)
    click = filt(rng.standard_normal(len(t)) * np.exp(-t / .003), "low", 3500) * .5
    return np.tanh((x + click) * 1.6)


def snare(dur=.4):
    t = tarr(dur)
    tone = np.sin(2 * np.pi * 185 * t) * np.exp(-t / .05) * .6 + np.sin(2 * np.pi * 330 * t) * np.exp(-t / .03) * .3
    nz = filt(rng.standard_normal(len(t)), "band", [1500, 9000]) * np.exp(-t / .1)
    return tone + nz * 1.1


def hat(open_=False):
    dur = .35 if open_ else .06
    t = tarr(dur)
    nz = filt(rng.standard_normal(len(t)), "high", 7000) * np.exp(-t / (.12 if open_ else .015))
    return nz


def tick(hi=True):
    t = tarr(.08)
    nz = filt(rng.standard_normal(len(t)) * np.exp(-t / .0025), "band", [2500, 7000] if hi else [1400, 5000])
    ping = np.sin(2 * np.pi * (3100 if hi else 2300) * t) * np.exp(-t / .012) * .45
    return nz * .9 + ping


def pluck(f, dur=.4, bright=1.0):
    t = tarr(dur)
    out = np.zeros_like(t)
    nh = int(min(28, (SR * .45) // f))
    for k in range(1, nh + 1):
        out += (1 / k) * np.sin(2 * np.pi * k * f * t + rng.uniform(0, 1)) * np.exp(-t * (5 + 3.2 * k / bright))
    return out * ar(len(t), .002, .03)


def bass(f, dur):
    t = tarr(dur)
    x = np.zeros_like(t)
    for k in range(1, 10):
        x += (1 / k) * np.sin(2 * np.pi * k * f * t) * np.exp(-t * (2 + 1.6 * k))
    x += .45 * np.sin(2 * np.pi * f * t)
    return np.tanh(x * 1.3) * ar(len(t), .003, .03)


def stab(chord, dur=.22):
    out = np.zeros(int(dur * SR))
    for nme in CHORDS[chord]:
        for d in (-.006, .006):
            out += saw_voice(hz(nme) * 2 * (1 + d), dur, nh=30, bright=lambda k, t: np.exp(-(k - 1) / (3 + 14 * np.exp(-t / .05))))
    out = np.tanh(out * .6)
    return out * ar(len(out), .002, .06)


def braam(root="D1", dur=5.0, gain=1.0):
    t = tarr(dur)
    bright = lambda k, tt: np.exp(-(k - 1) / (2.5 + 20 * np.exp(-tt / .7) * (1 - np.exp(-tt / .03))))
    f = hz(root)
    out = np.zeros_like(t)
    for ratio, g in [(1, 1.0), (2, .8), (3, .55), (4, .35), (4.756, .18)]:
        for d in (-.005, 0, .005):
            out += g * saw_voice(f * ratio * (1 + d), dur, nh=40, bright=bright)
    out = np.tanh(out * .35) * np.exp(-t / 1.8) * ar(len(t), .015, .4)
    return filt(out, "low", 5000) * gain


def impact(dur=3.0):
    t = tarr(dur)
    sub = np.sin(2 * np.pi * np.cumsum(28 + 50 * np.exp(-t / .25)) / SR) * np.exp(-t / .9)
    nz = filt(rng.standard_normal(len(t)), "low", 900) * np.exp(-t / .22)
    out = sub * .65 + nz * .9
    out[:int(.5 * SR)] += kick(110, 38, .5) * .7
    return filt(np.tanh(out * 1.2) * ar(len(t), .001, .3), "high", 32)


def swept_noise(dur, f0, f1, width=1.0, env=None):
    n = int(dur * SR)
    x = rng.standard_normal(n + 2048)
    f, tt, Z = signal.stft(x, fs=SR, nperseg=1024)
    frac = np.clip(tt / dur, 0, 1)
    fc = f0 * (f1 / f0) ** frac
    mask = np.exp(-.5 * ((np.log2(np.maximum(f, 1))[:, None] - np.log2(fc)[None, :]) / (width / 2)) ** 2)
    _, y = signal.istft(Z * mask, fs=SR, nperseg=1024)
    y = norm(y[:n])
    if env is not None:
        y = y * env(np.arange(n) / SR)
    return y


def riser(dur):
    return swept_noise(dur, 300, 9000, 1.4, lambda t: (t / dur) ** 2.2) + \
        .3 * np.sin(2 * np.pi * np.cumsum(110 * 2 ** (2 * np.arange(int(dur * SR)) / SR / dur)) / SR) * (np.arange(int(dur * SR)) / SR / dur) ** 2


def whoosh(dur=.3, up=True):
    return swept_noise(dur, 600 if up else 5000, 5000 if up else 600, 1.2,
                       lambda t: np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 2)


def reverse_swell(dur=1.6):
    n = int(dur * SR)
    nz = filt(rng.standard_normal(n), "high", 1200) * np.exp(-np.arange(n) / SR / (dur / 4))
    ir = make_ir(dur, dur * .9, 7000)[:, 0]
    y = signal.fftconvolve(nz, ir)[:n]
    return norm(y[::-1])


def heartbeat():
    out = np.zeros(int(.6 * SR))
    for off, g in ((0, 1.0), (.2, .7)):
        t = tarr(.35)
        x = np.sin(2 * np.pi * np.cumsum(38 + 30 * np.exp(-t / .03)) / SR) * np.exp(-t / .09) * g
        i = int(off * SR)
        out[i:i + len(x)] += x
    return np.tanh(filt(out, "low", 180) * 2.5)


def door_slam():
    out = np.zeros(int(2.5 * SR))
    imp = impact(2.4) * .9
    out[:len(imp)] += imp
    t = tarr(.15)
    wood = filt(rng.standard_normal(len(t)), "band", [120, 700]) * np.exp(-t / .04)
    out[:len(t)] += wood * 1.5
    t = tarr(.9)
    clank = sum(a * np.sin(2 * np.pi * f * t) * np.exp(-t / d)
                for f, a, d in [(1250, .5, .25), (2890, .35, .18), (4130, .25, .12), (5600, .15, .08)])
    clank += filt(rng.standard_normal(len(t)), "high", 3000) * np.exp(-t / .01) * .6
    i = int(.13 * SR)
    out[i:i + len(t)] += clank * .7
    return out


def power_down(dur=1.1):
    t = tarr(dur)
    fr = 25 + 200 * np.exp(-t / .25)
    ph = 2 * np.pi * np.cumsum(fr) / SR
    x = sum(np.sin(k * ph) / k for k in range(1, 12)) * np.exp(-t / .5)
    x[:int(.02 * SR)] += rng.standard_normal(int(.02 * SR)) * .5
    return filt(x, "low", 2500)


def blip(f=1050.0):
    t = tarr(.03)
    x = (np.sin(2 * np.pi * f * t) + .25 * np.sin(2 * np.pi * 3 * f * t)) * np.exp(-t / .009)
    return x * ar(len(t), .001, .005)


def grain_shimmer(dur, density=60):
    out = np.zeros(int(dur * SR))
    for _ in range(int(dur * density)):
        f = rng.uniform(2200, 6500)
        t = tarr(rng.uniform(.008, .025))
        g = np.sin(2 * np.pi * f * t) * np.hanning(len(t)) * rng.uniform(.2, 1)
        i = int(rng.uniform(0, dur) * SR)
        out[i:i + len(g)] += g[:len(out) - i]
    return out


def glitch(dur):
    out = np.zeros(int(dur * SR))
    pos = 0.0
    step = BEAT / 4
    while pos < dur:
        n = int(min(step, dur - pos) * SR * .85)
        t = np.arange(n) / SR
        f = rng.choice([55, 110, 220, 82.4, 146.8])
        sq = np.sign(np.sin(2 * np.pi * f * t)) * .6 + rng.standard_normal(n) * .25
        sq = np.round(sq * 6) / 6
        out[int(pos * SR):int(pos * SR) + n] += sq * ar(n, .001, .004)
        pos += step
        step = max(BEAT / 16, step * .82)
    return filt(out, "low", 7000)


def mod_jump():
    t = tarr(.22)
    fr = 300 * 4 ** (t / .22)
    return np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.sin(np.pi * t / .22) ** 2


def seat_out():
    t = tarr(.6)
    thum = np.sin(2 * np.pi * 85 * t) * np.exp(-t / .2)
    breath = filt(rng.standard_normal(len(t)), "band", [400, 2500]) * np.exp(-t / .12) * .4
    return thum + breath


def creak(dur=1.6):
    t = tarr(dur)
    pulses = np.zeros_like(t)
    rate = 18 + 10 * np.sin(2 * np.pi * .6 * t)
    ph = np.cumsum(rate) / SR
    pulses[np.diff(np.floor(ph), prepend=0) > 0] = 1.0
    y = np.zeros_like(t)
    for f, q in ((420, .04), (780, .03), (1310, .02)):
        y += signal.lfilter(*signal.iirpeak(f, 25, fs=SR), pulses) * 1.0
    return y * np.sin(np.pi * t / dur) ** .5


def screech(dur, notes=("D6", "Eb6", "A5")):
    out = np.zeros(int(dur * SR))
    for nme in notes:
        out += saw_voice(hz(nme), dur, nh=16, bright=lambda k, t: np.exp(-(k - 1) / 4), vib=.006, vib_rate=6.2)
    t = np.arange(len(out)) / SR
    return filt(out, "high", 900) * (t / dur) ** 1.5 * (1 + .3 * np.sin(2 * np.pi * 7 * t))


def rumble(dur):
    return filt(rng.standard_normal(int(dur * SR)), "low", 110, 4) * 3


def bone_click():
    """骨头相碰的干脆木质声。"""
    t = tarr(.12)
    nz = filt(rng.standard_normal(len(t)) * np.exp(-t / .004), "band", [500, 3000])
    ping = np.sin(2 * np.pi * rng.uniform(600, 900) * t) * np.exp(-t / .025) * .6
    return nz + ping


def coin_ring(dur=2.2):
    """金币落定的余音：不谐和的金属泛音。"""
    t = tarr(dur)
    x = sum(a * np.sin(2 * np.pi * f * t + rng.uniform(0, 6.28)) * np.exp(-t / d)
            for f, a, d in [(2093, .6, .9), (3378, .4, .6), (5231, .3, .4), (6901, .2, .25), (8200, .1, .15)])
    x[:int(.004 * SR)] += rng.standard_normal(int(.004 * SR)) * .5
    return x


def coin_spin(dur):
    """抛起后翻转的金币：泛音随转速一明一暗，越转越慢。"""
    t = tarr(dur)
    rate = 22 * (1 - t / dur) ** 1.5 + 3
    am = .5 + .5 * np.sin(2 * np.pi * np.cumsum(rate) / SR)
    x = sum(a * np.sin(2 * np.pi * f * t) for f, a in [(2093, .5), (3378, .3), (5231, .2)])
    return x * am * np.minimum(1, t / .05) * .5


# ---------------------------------------------------------------- 混响

def make_ir(dur, rt60, lp=6000):
    n = int(dur * SR)
    t = np.arange(n) / SR
    ir = rng.standard_normal((n, 2)) * np.exp(-6.9 * t / rt60)[:, None]
    ir = filt(ir, "low", lp)
    k = int(.012 * SR)
    ir[:k] *= np.linspace(0, 1, k)[:, None]
    return ir / np.sqrt((ir ** 2).sum(0))


# ---------------------------------------------------------------- 编排工具

def play_chime(b, notes, step=.5, pan=0.0, gain=.32, hall=.55):
    for i, nme in enumerate(notes):
        MX.add("music", tb(b + i * step), musicbox(hz(nme)), gain, pan, hall=hall)


def play_theme(b0, gain=.3, octave=0, hall=.6, stretch=1.0, upto=99, voice="box"):
    for off, nme, ln in THEME:
        if off >= upto:
            break
        f = hz(midi(nme) + 12 * octave)
        if voice == "box":
            MX.add("music", tb(b0 + off * stretch), musicbox(f), gain, .15 * np.sin(off), hall=hall)
        else:
            x = mix(pluck(f, ln * stretch * BEAT + .3, bright=2.5), .5 * pluck(f * 2, ln * stretch * BEAT + .2, 1.5))
            MX.add("music", tb(b0 + off * stretch), x, gain, 0, hall=hall)


def groove(b0, b1, chords, kick_pat=(0, 1, 2, 3), snare_pat=(1, 3), hats=True, open_hats=False,
           bass_step=.5, arp=True, arp_gain=.18, bass_gain=.3, kick_gain=.7, lowpass=None, stabs=()):
    """chords: [(起拍, 和弦名)]，按起拍排序。"""
    def chord_at(b):
        cur = chords[0][1]
        for cb, c in chords:
            if b >= cb:
                cur = c
        return cur

    bars = []
    b = b0
    while b < b1 - 1e-6:
        bars.append(b)
        b += 4
    parts = []
    for bar in bars:
        for kb in kick_pat:
            if bar + kb < b1:
                parts.append(("drums", bar + kb, kick() * kick_gain, 0, 0, .06))
                MX.kicks.append(tb(bar + kb))
        for sb in snare_pat:
            if bar + sb < b1:
                parts.append(("drums", bar + sb, snare() * .5, 0, .25, .1))
        if hats:
            for i in range(16):
                hb = bar + i * .25
                if hb < b1:
                    g = .24 if i % 2 else .15
                    parts.append(("drums", hb, hat() * g, .3 * ((i % 4) - 1.5) / 1.5, 0, .05))
        if open_hats:
            for i in range(4):
                hb = bar + i + .5
                if hb < b1:
                    parts.append(("drums", hb, hat(True) * .12, -.2, 0, .1))
        for sb in stabs:
            if bar + sb < b1:
                parts.append(("music", bar + sb, stab(chord_at(bar + sb)) * .22, 0, .3, .1))
    # 低音
    bb = b0
    i = 0
    while bb < b1 - 1e-6:
        c = chord_at(bb)
        f = hz(ROOTS[c]) * (2 if (i % 2 and bass_step <= .25) else 1)
        parts.append(("music", bb, bass(f, bass_step * BEAT * .95) * bass_gain, 0, 0, 0))
        bb += bass_step
        i += 1
    # 琶音
    if arp:
        pat = [0, 2, 1, 3, 2, 1, 3, 2]
        bb = b0
        i = 0
        while bb < b1 - 1e-6:
            notes = CHORDS[chord_at(bb)]
            f = hz(notes[pat[i % 8]])
            parts.append(("music", bb, pluck(f, .35) * arp_gain, .4 * np.sin(i * .9), .25, .1))
            bb += .25
            i += 1
    if lowpass is None:
        for bus, b, x, pan, hall, room in parts:
            MX.add(bus, tb(b), x, 1.0, pan, hall=hall, room=room)
    else:
        # 闷住的版本：先在临时轨上排好再整体低通
        tmp = np.zeros((int((b1 - b0) * BEAT * SR) + SR, 2))
        for bus, b, x, pan, hall, room in parts:
            th = (pan + 1) * np.pi / 4
            st = np.stack([x * np.cos(th), x * np.sin(th)], 1) * np.sqrt(2)
            i = int((tb(b) - tb(b0)) * SR)
            n = min(len(st), len(tmp) - i)
            tmp[i:i + n] += st[:n]
        tmp = filt(tmp, "low", lowpass, 4)
        MX.add("music", tb(b0), tmp, 1.0, hall=.2)


def roll(b0, b1, start_gain=.05, end_gain=.6, div=8):
    n = int((b1 - b0) * div)
    for i in range(n):
        g = start_gain + (end_gain - start_gain) * (i / max(1, n - 1)) ** 1.6
        MX.add("drums", tb(b0 + i / div), snare() * g, 1.0, .2 * np.sin(i), hall=.15)


def type_blips(b, text, end_b, pitch=1050):
    """广播字幕的打字音：与画面同样的逐字节奏。"""
    chars = [c for c in text]
    dur = min(len(chars) / 14.0, (end_b - b) * BEAT * .6)
    for i, c in enumerate(chars):
        if c in "，。、：？！—…■ " and c != "■":
            continue
        t = tb(b) + dur * i / len(chars)
        MX.add("sfx", t, blip(pitch * rng.uniform(.96, 1.04)), .09, rng.uniform(-.2, .2), room=.2)


# ---------------------------------------------------------------- 编排
# 所有时间都写成“某段起点 + 段内拍数”，改 timeline.json 的段落长度时这里自动跟着移。

def compose():
    S = {k: v[0] for k, v in TL["sections"].items()}
    E = {k: v[1] for k, v in TL["sections"].items()}

    # ===== 钟 → 序 → 醒来：持续的低音与钟表滴答 =====
    span = E["table"] - S["clock"] + 1
    d = drone(hz("D2"), tb(span))
    d *= np.clip(np.arange(len(d)) / (tb(6) * SR), 0, 1) ** 2
    MX.add("pad", tb(S["clock"]), d, .22, hall=.3)
    MX.add("pad", tb(S["clock"]), rumble(tb(span - 1)) * np.clip(np.arange(int(tb(span - 1) * SR)) / (tb(4) * SR), 0, 1), .08)
    bell_b = S["intro"]
    for b in range(S["clock"], bell_b):
        MX.add("sfx", tb(b), tick(b % 2 == 0), .5, .1 if b % 2 else -.1, room=.4, hall=.15)
    MX.add("sfx", tb(bell_b) - 1.6, reverse_swell(1.6), .35, hall=.2)
    MX.add("music", tb(bell_b), bell(hz("D3")), .55, 0, hall=.6)
    MX.add("music", tb(bell_b), impact(3) * .4, 1.0)
    for b in range(bell_b, E["table"]):
        MX.add("sfx", tb(b), tick(b % 2 == 0), .2, .1 if b % 2 else -.1, room=.4, hall=.1)
    play_chime(bell_b + 2, ["A5"], gain=.22)
    play_chime(bell_b + 4, ["F5"], gain=.2)
    play_chime(bell_b + 6, ["E5", "C#5"], step=1, gain=.2)
    n = E["table"] - bell_b
    MX.add("pad", tb(bell_b), drone(hz("A2"), tb(n)) * ar(int(tb(n) * SR), 3, 2), .1, hall=.3)

    t0 = S["table"]
    groups = [["D5", "F5", "A5"], ["E5", "G5", "Bb5"], ["F5", "A5", "D6"], ["E5", "G5", "C#6"], ["A4", "D5", "F5"]]
    for wg, notes in zip(TL["wakeGroups"], groups):
        for i, (seat, nme) in enumerate(zip(wg["seats"], notes)):
            MX.add("music", tb(wg["b"] + i * .5), musicbox(hz(nme)), .3, seat_pan(seat), hall=.55)
    play_theme(t0 + 10, gain=.28, upto=6)
    MX.add("sfx", tb(t0 + 8), grain_shimmer(tb(4), 45), .07, hall=.3)
    MX.add("pad", tb(t0 + 8), screech(tb(8), ("Eb5", "D5")), .04, hall=.4)
    MX.add("sfx", tb(t0 + 12), riser(tb(4)), .18, hall=.2)
    for b in range(t0 + 12, t0 + 16):
        MX.add("drums", tb(b), heartbeat(), .55)
    MX.add("sfx", tb(S["mansion"]) - 1.2, reverse_swell(1.2), .3)

    # ===== 洋馆的异常：四个镜头 =====
    m = S["mansion"]
    MX.add("music", tb(m), impact(3), .35)
    MX.add("pad", tb(m), pad(["D3", "Eb3", "A3"], tb(16.5), soft=3, a=1.0, r=1.5), .12, hall=.5)
    MX.add("pad", tb(m), drone(hz("D2"), tb(16.5)) * ar(int(tb(16.5) * SR), .5, 1.0), .14, hall=.3)
    for b in range(m, m + 16, 2):
        MX.add("drums", tb(b), kick(90, 38, .5, .3) * .6, 1.0, hall=.15)
        MX.kicks.append(tb(b))
    # 一：假窗，墙上的钟一日走完
    for i in range(16):
        MX.add("sfx", tb(m + i * .25), tick(i % 2 == 0), .12, .5, room=.3)
    MX.add("pad", tb(m), pad(["A3", "D4", "E4"], tb(4), soft=4, a=1.2, r=1.4), .1, hall=.6)
    # 二：骨架
    for k in (4, 8, 12):
        MX.add("sfx", tb(m + k) - .8, reverse_swell(.8), .22)
        MX.add("music", tb(m + k), impact(2.5), .22)
    for i in range(12):
        MX.add("sfx", tb(m + 4 + rng.uniform(.2, 3.6)), bone_click(), .22, rng.uniform(-.6, .6), hall=.35)
    # 三：双月挂毯
    MX.add("music", tb(m + 8.2), bell(hz("A4"), 6), .22, -.35, hall=.7)
    MX.add("music", tb(m + 9.6), bell(hz("D3"), 6), .28, .35, hall=.7)
    MX.add("sfx", tb(m + 8), grain_shimmer(tb(4), 35), .06, hall=.5)
    # 四：八位无名观测者
    for i, nme in enumerate(["D4", "E4", "F4", "G4", "A4", "Bb4", "C#5", "D5"]):
        MX.add("music", tb(m + 12 + i * .22), pluck(hz(nme), .8, 1.2), .12, (i - 3.5) / 5, hall=.5)
    MX.add("pad", tb(m + 15), pad(["D4", "Eb4", "Ab4"], tb(1.2), soft=3, a=.8, r=.2), .16, hall=.4)
    for p in TL["placards"]:
        n = len(p["text"])
        for i, c in enumerate(p["text"]):
            if c in " 　·":
                continue
            MX.add("sfx", tb(p["b"] + (p["decodeEnd"] - p["b"]) * (i + 1) / n), blip(760 + 30 * (i % 6)), .06, room=.3)
    MX.add("sfx", tb(S["host"]) - 1.2, reverse_swell(1.2), .3)

    # ===== 主持人：未知字形 =====
    h = S["host"]
    MX.add("music", tb(h), impact(3), .55)
    MX.add("pad", tb(h), drone(hz("D2"), tb(8.5)) * ar(int(tb(8.5) * SR), .05, 1.0), .2, hall=.2)
    groove(h, h + 8, [(h, "Dm"), (h + 4, "Bb")], kick_pat=(0, 2), snare_pat=(), hats=True, arp=False,
           bass_step=.5, bass_gain=.3, kick_gain=.6)
    for hl in TL["hostLines"]:
        n = len(hl["text"])
        MX.add("sfx", tb(hl["b"]), grain_shimmer(tb(hl["decodeEnd"] - hl["b"]), 70), .06, hall=.3)
        for i in range(n):
            if hl["text"][i] in "，。":
                continue
            MX.add("sfx", tb(hl["b"] + (hl["decodeEnd"] - hl["b"]) * (i + 1) / n), blip(700 + 25 * (i % 7)), .08, room=.3)

    # ===== 身份卡 =====
    c = S["card"]
    groove(c, c + 8, [(c, "Gm"), (c + 4, "A")], kick_pat=(0, 2), snare_pat=(3,), hats=True,
           bass_step=.5, arp=True, arp_gain=.13, bass_gain=.34, kick_gain=.7)
    fc = TL["firstCard"]
    MX.add("sfx", tb(fc["inB"]), whoosh(.45), .25, hall=.2)
    MX.add("sfx", tb(fc["flipB"]) - .15, whoosh(.3), .3)
    MX.add("sfx", tb(fc["flipB"]) + .12, mix(kick(90, 35, .6) * .7, tick() * .4), .7, hall=.3)
    MX.add("music", tb(fc["flipB"]) + .12, bell(hz("A2"), 5), .25, hall=.5)

    f = S["flips"]
    groove(f, f + 8, [(f, "Dm"), (f + 4, "Bb"), (f + 6, "A")], kick_pat=(0, 1, 2, 3), snare_pat=(1, 3),
           hats=True, open_hats=True, bass_step=.25, arp=True, arp_gain=.15, stabs=(.5, 2.5))
    for i in range(len(TL["flipCards"])):
        b = TL["flipStart"]["b"] + i
        MX.add("sfx", tb(b), whoosh(.2), .14, (-1) ** i * .4)
        MX.add("sfx", tb(b + .5), tick(True), .5, (-1) ** i * .3, room=.3)

    # ===== 金币 =====
    k = S["coins"]
    groove(k, k + 4, [(k, "Dm")], kick_pat=(0, 2), snare_pat=(3,), hats=True, bass_step=.5,
           arp=True, arp_gain=.11, bass_gain=.3, kick_gain=.65)
    cf = TL["coinFlip"]
    MX.add("sfx", tb(cf["b"]), coin_spin(tb(cf["until"] - cf["b"])), .32, hall=.35)
    MX.add("sfx", tb(cf["until"]), coin_ring(), .4, hall=.45)
    groove(k + 4, k + 8, [(k + 4, "Bb"), (k + 6, "A")], kick_pat=(0, 2), snare_pat=(1, 3), hats=True,
           bass_step=.25, arp=True, arp_gain=.13, bass_gain=.32)
    pl = TL["plaque"]
    for i in range(len(pl["rows"])):
        MX.add("sfx", tb(pl["b"] + i * pl["step"]), blip(820 + 50 * i) * 1.4, .1, room=.3)
    last = pl["b"] + (len(pl["rows"]) - 1) * pl["step"] + .2
    MX.add("music", tb(last), mix(stab("Dm", .5), braam("D1", 2.5, .6)), .45, hall=.5)
    MX.add("music", tb(last), bell(hz("D3"), 5), .3, hall=.6)
    # 付款与交付：无声无光。整段切成静场，只剩底噪和心跳
    MX.mutes.append((k + 8, S["commission"]))
    MX.add("post", tb(k + 8), rumble(tb(4)), .03)
    for b in (k + 10, k + 11):
        MX.add("post", tb(b), heartbeat(), .5)
    MX.add("post", tb(S["commission"]) - 1.0, reverse_swell(1.0), .4)

    # ===== 受命者 =====
    s = S["commission"]
    MX.add("music", tb(s), braam("D1", 4.5), .5, hall=.35)
    MX.add("music", tb(s), impact(3), .6)
    MX.add("pad", tb(s), screech(tb(4.2)), .1, hall=.5)
    MX.add("pad", tb(s), drone(hz("D1"), tb(4)) * ar(int(tb(4) * SR), .01, .3), .25)

    # ===== 二十四小时 =====
    s = S["countdown"]
    MX.add("drums", tb(s), mix(kick() * .9, snare() * .5), 1.0, hall=.2)
    MX.add("music", tb(s), bass(hz("A1"), tb(4)) * np.linspace(1, .6, int(tb(4) * SR)), .35)
    for i in range(12):
        MX.add("sfx", tb(s + i * .25), tick(i % 2 == 0), .4, room=.2)
    for i in range(8):
        MX.add("sfx", tb(s + 3 + i * .125), tick(i % 2 == 0), .45, room=.2)
    MX.add("sfx", tb(s), riser(tb(4)), .3)
    roll(s + 2, s + 4, .05, .45, 8)
    for b in range(s, s + 4):
        MX.add("drums", tb(b), kick() * .6, 1.0)
        MX.kicks.append(tb(b))

    # ===== 黑暗 =====
    s = S["blackout"]
    MX.add("pad", tb(s), drone(hz("D1"), tb(8)) * ar(int(tb(8) * SR), .5, 1), .16)
    for tx in TL["texts"]:
        if tx.get("blip"):
            type_blips(tx["b"], tx["text"], tx["until"])
    MX.add("sfx", tb(s + 2), power_down(), .55, hall=.3)
    for b in range(s + 2, S["door"] + 4):
        MX.add("drums", tb(b), heartbeat(), .75 if b < S["door"] else .85)

    # ===== 典狱长的门 =====
    s = S["door"]
    MX.add("sfx", tb(s), door_slam(), .95, hall=.45)
    MX.add("pad", tb(s + 2), screech(tb(2)), .09, hall=.4)
    MX.add("sfx", tb(S["body"]) - 1.4, reverse_swell(1.4), .4)

    # ===== 发现尸体 =====
    s = S["body"]
    MX.add("music", tb(s), braam("D1", 6), .7, hall=.35)
    MX.add("music", tb(s), impact(3), .8)
    MX.add("music", tb(s), bell(hz("D3"), 8), .4, hall=.6)
    MX.add("music", tb(s), stab("Dm", .5) + stab("A", .5) * .6, .3, hall=.6)
    for i in range(8):
        MX.add("sfx", tb(s + 2 + i * .25), tick(i % 2 == 0), .25, room=.3)

    # ===== 调查 =====
    s = S["investigate"]
    groove(s, s + 8, [(s, "Dm"), (s + 4, "Bb"), (s + 6, "A")], kick_pat=(0, 2), snare_pat=(), hats=False,
           bass_step=.25, arp=False, bass_gain=.36, kick_gain=.75)
    for i in range(32):
        MX.add("sfx", tb(s + i * .25), tick(i % 2 == 0), .28 if i % 2 == 0 else .18, room=.25)
    c1 = TL["clues1"]
    for i, _ in enumerate(c1["words"]):
        MX.add("sfx", tb(c1["b"] + i * c1["step"]), mix(glitch(.12) * .5, kick(200, 60, .2) * .4), .45, (-1) ** i * .3)
    c2 = TL["clues2"]
    for i, _ in enumerate(c2["words"]):
        MX.add("sfx", tb(c2["b"] + i * c2["step"]), mix(blip(1500 + 120 * i) * 1.5, tick() * .5), .35, (-1) ** i * .4)
    MX.add("pad", tb(s + 2), pad(["D4", "Eb4", "A4"], tb(6), soft=3, a=2, r=1), .12, hall=.4)
    roll(s + 6, s + 8, .04, .5, 8)
    MX.add("sfx", tb(s + 6), riser(tb(2)), .3)

    # ===== 开庭 =====
    s = S["trialOpen"]
    MX.add("music", tb(s), braam("D1", 5), .6, hall=.35)
    MX.add("music", tb(s), impact(3), .7)
    MX.add("music", tb(s), bell(hz("D3"), 8), .35, hall=.6)
    groove(s, s + 4, [(s, "Dm")], kick_pat=(0, 2), snare_pat=(), hats=False, arp=False,
           bass_step=1, bass_gain=.3, kick_gain=.6)
    MX.add("pad", tb(s), pad(["D3", "A3", "E4", "F4"], tb(4.2), soft=3, a=.8, r=.6), .14, hall=.5)
    MX.add("sfx", tb(s + 1.5), grain_shimmer(tb(2), 120) * np.linspace(1, 0, int(tb(2) * SR)), .12, hall=.5)

    # ===== 辩论 =====
    s = S["debate"]
    groove(s, s + 8, [(s, "Dm"), (s + 4, "Bb")], kick_pat=(0, 1, 2, 3), snare_pat=(1, 3), hats=True,
           open_hats=True, bass_step=.25, arp=True, arp_gain=.15, stabs=(1.5, 3.5))
    for dl in TL["debate"]:
        MX.add("sfx", tb(dl["b"]), mix(whoosh(.18) * .5, blip(820) * .8), .3, seat_pan(dl["seat"]), room=.2)

    # ===== 投票 =====
    s = S["vote"]
    groove(s, s + 1, [(s, "Gm")], kick_pat=(0,), snare_pat=(), hats=False, arp=False, bass_step=1, bass_gain=.3)
    groove(s + 1, s + 8, [(s + 1, "Gm"), (s + 4, "A")], kick_pat=(0, 1, 2, 3), snare_pat=(1, 3), hats=True,
           bass_step=.25, arp=True, arp_gain=.13)
    v = TL["votes"]
    counts = {}
    for i, tgt in enumerate(v["targets"]):
        counts[tgt] = counts.get(tgt, 0) + 1
        MX.add("sfx", tb(v["b"] + i * v["step"]), blip(520 * 2 ** ((counts[tgt] - 1) * 2 / 12)) * 2, .22, seat_pan(i + 1), room=.2)
    for hm in TL["hiddenMods"]:
        MX.add("sfx", tb(hm["b"]), mod_jump() if hm["delta"] > 0 else mod_jump()[::-1], .3, seat_pan(hm["seat"]), hall=.4)
    MX.add("sfx", tb(s + 7), reverse_swell(tb(1)), .35)

    # ===== 判决 =====
    s = S["verdict"]
    vb = TL["verdict"]["b"]
    MX.add("sfx", tb(s), glitch(tb(vb - s)), .4)
    MX.add("music", tb(vb), braam("D1", 5), .65, hall=.35)
    MX.add("music", tb(vb), impact(3), .75)
    MX.add("music", tb(vb), stab("Dm", .6), .35, hall=.6)
    MX.add("pad", tb(vb), drone(hz("D1"), tb(E["verdict"] - vb + .2)) * ar(int(tb(E["verdict"] - vb + .2) * SR), .3, .4), .18)
    for b in (s + 2, s + 3):
        MX.add("drums", tb(b), heartbeat(), .6)

    # ===== 真凶逃过；书桌上无声多出十枚金币 =====
    s, dk = S["escape"], TL["escapeDesk"]["b"]
    groove(s, dk, [(s, "Bb")], kick_pat=(0, 2), snare_pat=(3,), hats=True, bass_step=.25,
           arp=True, arp_gain=.2, lowpass=900)
    MX.add("pad", tb(s), screech(tb(dk - s), ("D5", "A5")), .06, hall=.4)
    MX.mutes.append((dk, E["escape"]))
    MX.add("post", tb(dk), drone(hz("D2"), tb(E["escape"] - dk)) * ar(int(tb(E["escape"] - dk) * SR), .05, .3), .12)
    MX.add("post", tb(dk + 1.5), heartbeat(), .45)
    MX.add("post", tb(E["escape"] - 1), reverse_swell(tb(1)), .4)

    # ===== 群像 =====
    s = S["names"]
    groove(s, s + 8, [(s, "Dm"), (s + 2, "Bb"), (s + 4, "Gm"), (s + 6, "A")], kick_pat=(0, 1, 2, 3),
           snare_pat=(1, 3), hats=True, open_hats=True, bass_step=.25, arp=True, arp_gain=.12, stabs=(.5, 2.5))
    play_theme(s, gain=.24, octave=0, hall=.3, stretch=.5, voice="lead")
    nm = TL["names"]
    for i in range(len(nm["list"])):
        if i < nm["slowCount"]:
            b = nm["b"] + i * nm["slow"]
            MX.add("sfx", tb(b), mix(kick(180, 50, .25) * .5, whoosh(.15) * .3), .5, (-1) ** i * .25)
        else:
            b = nm["b"] + nm["slowCount"] * nm["slow"] + (i - nm["slowCount"]) * nm["fast"]
            MX.add("sfx", tb(b), mix(tick(i % 2 == 0) * .6, blip(900 + 40 * i) * .5), .4, (-1) ** i * .3)
    roll(s + 6, s + 8, .05, .55, 8)
    MX.add("sfx", tb(s + 4), riser(tb(4)), .32)

    # ===== 黑钻石封墙 =====
    s = S["wall"]
    MX.add("sfx", tb(s + .2), creak(1.6), .25, -.2, hall=.5)
    MX.add("music", tb(s + 1.5), impact(3.5), .55, hall=.3)
    MX.add("pad", tb(s), drone(hz("D1"), tb(4.5)) * ar(int(tb(4.5) * SR), 1.0, 1.0), .2)
    MX.add("pad", tb(s + 1.5), screech(tb(2.5), ("A6", "Bb6")), .03, hall=.6)

    # ===== 愿望 =====
    s = S["wish"]
    play_theme(s, gain=.28, hall=.75, upto=8)
    MX.add("pad", tb(s), pad(["D3", "A3", "F4"], tb(4.5), soft=3, a=2, r=1.5), .13, hall=.6)
    so = TL["seatOff"]
    for seat, b in zip(so["order"], so["times"]):
        MX.add("sfx", tb(b), seat_out(), .3, seat_pan(seat), hall=.3)
    MX.add("pad", tb(s + 4), pad(["D3", "A3", "D4", "F#4", "A4"], tb(6), soft=5, a=1.2, r=2.5, vib=.004), .2, hall=.7)
    play_chime(s + 4, ["F#5", "A5", "D6"], step=.5, gain=.22, hall=.8)

    # ===== 片名 =====
    tt = TL["title"]
    MX.add("sfx", tb(tt["b"]) - 2.0, reverse_swell(2.0), .45)
    MX.add("music", tb(tt["b"]), braam("D1", 7), .75, hall=.4)
    MX.add("music", tb(tt["b"]), impact(4), .85)
    MX.add("music", tb(tt["b"]), bell(hz("D3"), 11), .5, hall=.7)
    MX.add("pad", tb(tt["b"]), pad(["D2", "A2", "D3", "F3", "A3"], tb(12), soft=3, a=.05, r=5), .2, hall=.6)
    MX.add("music", tb(tt["tagB"]), musicbox(hz("A5"), 4), .22, hall=.8)
    MX.add("music", tb(tt["b"] + 6), musicbox(hz("D5"), 4), .2, hall=.85)
    MX.add("sfx", tb(tt["b"] + 10), tick(True), .3, hall=.6)


# ---------------------------------------------------------------- 母带

def sidechain():
    env = np.ones(N)
    k = np.exp(-np.arange(int(.25 * SR)) / SR / .09)
    for t in MX.kicks:
        i = int(t * SR)
        n = min(len(k), N - i)
        if n > 0:
            env[i:i + n] = np.minimum(env[i:i + n], 1 - .55 * k[:n])
    return env[:, None]


def compress(x, thresh=.35, ratio=3.0):
    hop = 64
    m = np.max(np.abs(x), axis=1)
    m = m[: len(m) // hop * hop].reshape(-1, hop).max(1)
    env = np.zeros_like(m)
    e = 0.0
    att, rel = np.exp(-1 / (.003 * SR / hop)), np.exp(-1 / (.18 * SR / hop))
    for i, v in enumerate(m):
        e = att * e + (1 - att) * v if v > e else rel * e + (1 - rel) * v
        env[i] = e
    gain = np.ones_like(env)
    over = env > thresh
    gain[over] = (thresh * (env[over] / thresh) ** (1 / ratio)) / env[over]
    g = np.repeat(gain, hop)
    g = np.concatenate([g, np.full(len(x) - len(g), g[-1])])
    return x * g[:, None]


# 各段目标响度（dB，相对值）：前奏压低，庭审与群像最响，片尾回落。
# 值为列表时按段内区间分别设定，None 表示该区间不调（例如刻意留白的静场）。
TARGETS = {
    "clock": -29, "intro": -25, "table": -23, "mansion": -22, "host": -21, "card": -19, "flips": -17,
    "coins": [(0, 8, -18), (8, 12, None)],
    "commission": -18, "countdown": -16, "blackout": -25, "door": -18, "body": -16,
    "investigate": -18, "trialOpen": -17, "debate": -15, "vote": -15, "verdict": -16.5,
    "escape": [(0, 4, -18), (4, 8, None)], "names": -14, "wall": -22, "wish": -21, "title": -16,
}


def loudness(x):
    """近似感知响度：去掉 80 Hz 以下再取均方根。"""
    y = filt(x.mean(1), "high", 80)
    return 10 * np.log10((y ** 2).mean() + 1e-12)


def automation(out):
    g = np.zeros(len(out))
    ramp = int(.12 * SR)
    for name, (a, b) in TL["sections"].items():
        zones = TARGETS[name] if isinstance(TARGETS[name], list) else [(0, b - a, TARGETS[name])]
        for z0, z1, target in zones:
            i0, i1 = int(tb(a + z0) * SR), int(tb(a + z1) * SR)
            if target is not None:
                g[i0:i1] = np.clip(target - loudness(out[i0:i1]), -14, 10)
    # 平滑：每个分界点前 0.12 秒内过渡
    k = np.ones(ramp) / ramp
    g = np.convolve(np.pad(g, (0, ramp - 1), mode="edge"), k, mode="valid")[:len(out)]
    return out * (10 ** (g / 20))[:, None]


def limit(x, ceiling):
    """前瞻限幅：只压冲击音的尖峰，给整体响度留出余量。"""
    la = int(.005 * SR)
    g = np.minimum(1.0, ceiling / (np.max(np.abs(x), axis=1) + 1e-9))
    g = minimum_filter1d(g, size=2 * la + 1)
    g = uniform_filter1d(g, size=2 * la + 1)
    g = minimum_filter1d(g, size=int(.06 * SR))
    g = uniform_filter1d(g, size=int(.06 * SR))
    return x * g[:, None]


def gate():
    """静音区：起点 30 毫秒内切到 -40 dB，终点前 0.15 秒放开。"""
    g = np.ones(N)
    for b0, b1 in MX.mutes:
        i0, i1 = int(tb(b0) * SR), int(tb(b1) * SR)
        env = np.full(i1 - i0, 10 ** (-40 / 20))
        a, r = int(.03 * SR), int(.15 * SR)
        env[:a] = np.linspace(1, env[0], a)
        env[-r:] = np.linspace(env[0], 1, r)
        g[i0:i1] = np.minimum(g[i0:i1], env)
    return g


def master():
    sc = sidechain()
    dry = MX.bus["drums"] + MX.bus["sfx"] + (MX.bus["music"] + filt(MX.bus["pad"], "high", 55)) * sc
    hall = make_ir(4.0, 3.4, 6500)
    room = make_ir(1.4, .9, 8000)
    wet = np.zeros_like(dry)
    for c in range(2):
        wet[:, c] += signal.fftconvolve(MX.hall[:, c], hall[:, c])[:N] * .9
        wet[:, c] += signal.fftconvolve(MX.room[:, c], room[:, c])[:N] * .6
    out = (dry + wet) * gate()[:, None] + MX.bus["post"]
    out = filt(out, "high", 28)
    out = out - .3 * filt(out, "low", 100)
    out = automation(out)
    out = compress(out, thresh=.5, ratio=2.5)
    end = int(tb(TOTAL_BEATS) * SR)
    fade = int(tb(4) * SR)
    out[end - fade:end] *= np.linspace(1, 0, fade)[:, None] ** 1.5
    out = norm(out[:end], 1.0)
    out = limit(out, .5)
    return norm(out, .84)


def write_wav(path, x):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


if __name__ == "__main__":
    out_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "build", "music.wav")
    compose()
    write_wav(out_path, master())
    print("wrote", out_path, f"{TOTAL_BEATS * BEAT:.1f}s")
