#!/usr/bin/env python3
"""
Generate broadcast-grade TTS narration + subtle studio ambient bed + 2-pass -14 LUFS master
for BasisDesk 2-minute demo video.
"""
import asyncio
import json
import math
import os
import re
import subprocess
import wave
from pathlib import Path

import edge_tts
import numpy as np

FFMPEG = "/Users/mac/GENAI/agent-earn/dorahacks/even-realities/demo-video/bin/ffmpeg"
FFPROBE = "/Users/mac/GENAI/agent-earn/dorahacks/even-realities/demo-video/bin/ffprobe"

BASE_DIR = Path("/Users/mac/GENAI/agent-earn/akindo/sosovalue-desk/demo-video")
AUDIO_DIR = BASE_DIR / "audio"
AUDIO_DIR.mkdir(parents=True, exist_ok=True)

VOICE = "en-US-BrianNeural"
RATE = "+14%"

CHAPTERS = [
    {"id": 1, "short": "01 Overview", "title": "Overview Desk & Telemetry"},
    {"id": 2, "short": "02 Basis & L2", "title": "Live SoDEX 500ms L2 & Carry"},
    {"id": 3, "short": "03 Stress Lab", "title": "1,000-Path Monte Carlo Risk"},
    {"id": 4, "short": "04 SSI Protocol", "title": "SSI Rebalancer & ValueChain"},
    {"id": 5, "short": "05 Controls & Ship", "title": "Risk Gate, Blotter & Deploy"},
]

# Tight 2-minute quant-founder script (~118-124s target, zero AI clichés, 100% matched to screenshots)
CUES = [
    # --- Chapter 1: Overview Desk (~25s) ---
    {
        "id": "cue_01",
        "chapter": 1,
        "scene": "intro_title",
        "pause_after": 0.18,
        "tts": "Solo carry trading takes five tabs. BasisDesk puts the whole desk in one terminal.",
        "sub_lines": [
            "Solo carry trading usually takes five tabs.",
            "BasisDesk puts the whole desk in one terminal.",
        ],
    },
    {
        "id": "cue_02",
        "chapter": 1,
        "scene": "overview_top",
        "pause_after": 0.14,
        "tts": "Built on SoSoValue, SoDEX, ValueChain, and SSI Protocol, every feed has an honest badge.",
        "sub_lines": [
            "Built on SoSoValue, SoDEX, ValueChain, and SSI Protocol —",
            "every feed carries an explicit, honest telemetry badge.",
        ],
    },
    {
        "id": "cue_03",
        "chapter": 1,
        "scene": "overview_telemetry_zoom",
        "pause_after": 0.14,
        "tts": "Live SoDEX WebSockets, ValueChain Chain 286623 RPC with two-second finality, and clear snapshot tags.",
        "sub_lines": [
            "Live SoDEX WS · ValueChain Chain 286623 RPC (2s finality, block #17,316,539)",
            "and clear SNAPSHOT tags whenever no SoSoValue API key is loaded.",
        ],
    },
    {
        "id": "cue_04",
        "chapter": 1,
        "scene": "overview_brief_matrix",
        "pause_after": 0.30,
        "tts": "The Desk Brief pairs 1.04 billion in ETF flows with funding across 107 perps and 48 spot pairs. AVAX leads at 7.17 percent.",
        "sub_lines": [
            "Desk Brief pairs +$1.04B 5D ETF flows with live funding across",
            "107 perps & 48 spot pairs — led by AVAX-USD at +7.17% net carry APY.",
        ],
    },
    # --- Chapter 2: Live SoDEX Basis & 500ms L2 Book (~24s) ---
    {
        "id": "cue_05",
        "chapter": 2,
        "scene": "basis_full",
        "pause_after": 0.12,
        "tts": "Click Analyze on any pair for the Basis and L2 Book.",
        "sub_lines": [
            "Click Analyze on any pair to open the live Basis & L2 Book Desk.",
        ],
    },
    {
        "id": "cue_06",
        "chapter": 2,
        "scene": "basis_l2_zoom",
        "pause_after": 0.14,
        "tts": "On BTC-USD, 500-millisecond depth streams a 0.17 basis-point spread, live tape, and 200x Impact Notional.",
        "sub_lines": [
            "BTC-USD 500ms WebSocket depth: 0.17 bps spread, live matching-engine tape,",
            "and SoDEX's official 200× MaxLev Impact Notional premium.",
        ],
    },
    {
        "id": "cue_07",
        "chapter": 2,
        "scene": "basis_spot_zoom",
        "pause_after": 0.14,
        "tts": "Depth walking prices slippage across 1.71 million against the vBTC spot leg at 5.1 basis points.",
        "sub_lines": [
            "Depth walking prices execution slippage across $1.71M top-15 liquidity —",
            "paired with the ValueChain vBTC_vUSDC Spot CLOB at +5.1 bps live basis.",
        ],
    },
    {
        "id": "cue_08",
        "chapter": 2,
        "scene": "basis_carry_zoom",
        "pause_after": 0.30,
        "tts": "Slide size, leverage, or horizon for net carry APY, maker fees, 10.1-day breakeven, and liquidation price.",
        "sub_lines": [
            "Slide size, leverage, or horizon for live Net Carry APY (+2.28%),",
            "exact SoDEX maker fees, 10.1-day breakeven, and tiered liquidation buffer.",
        ],
    },
    # --- Chapter 3: 1,000-Path Monte Carlo Risk Stress Lab (~21s) ---
    {
        "id": "cue_09",
        "chapter": 3,
        "scene": "stress_full",
        "pause_after": 0.14,
        "tts": "Delta-neutral is not liquidation-proof. Basis spikes squeeze short margin before spot helps.",
        "sub_lines": [
            "Delta-neutral is not liquidation-proof.",
            "Basis spikes squeeze short margin before spot gains can bail you out.",
        ],
    },
    {
        "id": "cue_10",
        "chapter": 3,
        "scene": "stress_metrics_zoom",
        "pause_after": 0.14,
        "tts": "Our 1,000-path Monte Carlo lab tests a 180 basis-point blowout at 6x: minus 21,125 99-percent C-Var and 48 percent liquidation risk.",
        "sub_lines": [
            "1,000-path seeded Monte Carlo · Basis Blowout (+180 bps) at 6x leverage:",
            "99% CVaR reaches -$21,125 and Perp Liquidation Probability hits 48.0%.",
        ],
    },
    {
        "id": "cue_11",
        "chapter": 3,
        "scene": "stress_charts_zoom",
        "pause_after": 0.30,
        "tts": "Every path checks live SoDEX margin tiers, mapping P5 floors and staged unwind limits.",
        "sub_lines": [
            "Every path checks live SoDEX maintenance tiers (1.25% MMR ≤ $4M) —",
            "mapping P5–P95 equity envelopes, VaR tails, and staged unwind thresholds.",
        ],
    },
    # --- Chapter 4: SSI Protocol Rebalancer & ValueChain Settlement (~22s) ---
    {
        "id": "cue_12",
        "chapter": 4,
        "scene": "ssi_top",
        "pause_after": 0.14,
        "tts": "In SSI Rebalancer, Mag-7, DeFi, and USSI spot prices track implied I-NAV, flagging Mag-7 at minus 36.6 basis points.",
        "sub_lines": [
            "Live SoDEX spot prices for MAG7.ssi, DEFI.ssi & USSI vs. implied iNAV —",
            "flagging MAG7.ssi at a -36.6 bps discount (Buy Spot & Redeem).",
        ],
    },
    {
        "id": "cue_13",
        "chapter": 4,
        "scene": "ssi_drift_zoom",
        "pause_after": 0.14,
        "tts": "Modeled on AssetRebalancer dot sol, a 0.8 percent buffer holds four assets idle, cutting turnover to 1.69 percent.",
        "sub_lines": [
            "Modeled on AssetRebalancer.sol: a ±0.8% drift buffer holds 4 assets IN BUFFER,",
            "trading only BTC, ETH & XRP — cutting turnover to 1.69% ($1,686).",
        ],
    },
    {
        "id": "cue_14",
        "chapter": 4,
        "scene": "ssi_calldata_zoom",
        "pause_after": 0.30,
        "tts": "It prices live Chain 286623 SOSO gas with a 10-to-the-8 tokenset calldata preview.",
        "sub_lines": [
            "Live ValueChain Chain 286623 gas (0.00000084 SOSO) plus",
            "exact AssetRebalancer.sol 10^8 tokenset calldata preview.",
        ],
    },
    # --- Chapter 5: Pre-Trade Controls, Blotter & Production Ship (~23s) ---
    {
        "id": "cue_15",
        "chapter": 5,
        "scene": "risk_gate_zoom",
        "pause_after": 0.14,
        "tts": "Five pre-trade guardrails audit leverage, liquidation buffer, slippage, concentration, and 99 percent value-at-risk.",
        "sub_lines": [
            "Five automated pre-trade guardrails audit leverage, liquidation buffer,",
            "L2 slippage, concentration, and 99% VaR budget before staging.",
        ],
    },
    {
        "id": "cue_16",
        "chapter": 5,
        "scene": "blotter_zoom",
        "pause_after": 0.16,
        "tts": "Zero-custody confirmation logs to the live Paper Blotter, with memory-only BYOK SoSoValue keys.",
        "sub_lines": [
            "Two-step zero-custody confirmation logs to the live MTM Paper Blotter —",
            "with optional BYOK SoSoValue API keys kept in browser memory only.",
        ],
    },
    {
        "id": "cue_17",
        "chapter": 5,
        "scene": "outro_proof",
        "pause_after": 0.18,
        "tts": "Ships with 16 of 16 Vitest tests passing, GitHub Pages deploy, and hourly snapshot CI.",
        "sub_lines": [
            "16/16 Vitest unit tests passing · strict TypeScript verification ·",
            "live GitHub Pages static deployment backed by hourly snapshot CI.",
        ],
    },
    {
        "id": "cue_18",
        "chapter": 5,
        "scene": "outro_final",
        "pause_after": 0.85,
        "tts": "Zero custody. Honest telemetry. Quant discipline for a solo desk. BasisDesk.",
        "sub_lines": [
            "Zero custody. Honest telemetry.",
            "Quant discipline for a one-person on-chain desk. BasisDesk.",
        ],
    },
]


def ffprobe_duration(path: Path) -> float:
    out = subprocess.check_output(
        [
            FFPROBE,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        text=True,
    ).strip()
    return float(out)


async def synth_cue(cue: dict, sem: asyncio.Semaphore) -> dict:
    mp3_path = AUDIO_DIR / f"{cue['id']}.mp3"
    wav_path = AUDIO_DIR / f"{cue['id']}.wav"

    words = []
    audio_chunks = bytearray()
    async with sem:
        for attempt in range(4):
            try:
                words.clear()
                audio_chunks.clear()
                comm = edge_tts.Communicate(
                    cue["tts"],
                    voice=VOICE,
                    rate=RATE,
                    boundary="WordBoundary",
                )
                async for chunk in comm.stream():
                    if chunk["type"] == "audio":
                        audio_chunks.extend(chunk["data"])
                    elif chunk["type"] == "WordBoundary":
                        words.append(
                            {
                                "text": chunk["text"],
                                "offset_s": chunk["offset"] / 1e7,
                                "duration_s": chunk["duration"] / 1e7,
                            }
                        )
                if len(audio_chunks) > 500:
                    break
            except Exception as exc:
                if attempt == 3:
                    raise
                print(f"  retry {attempt + 1} for {cue['id']}: {exc}")
                await asyncio.sleep(1.0 + attempt)
    mp3_path.write_bytes(bytes(audio_chunks))

    # Decode + clean vocal EQ + trim leading/trailing dead silence gently (keep 40ms tail)
    subprocess.run(
        [
            FFMPEG,
            "-y",
            "-v",
            "error",
            "-i",
            str(mp3_path),
            "-af",
            (
                "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02,"
                "areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.04,areverse,"
                "highpass=f=75,"
                "equalizer=f=220:t=q:w=1.2:g=-1.2,"
                "equalizer=f=3200:t=q:w=1.3:g=1.8,"
                "acompressor=threshold=-20dB:ratio=2.4:attack=10:release=110:makeup=1.5"
            ),
            "-ar",
            "48000",
            "-ac",
            "2",
            "-c:a",
            "pcm_s16le",
            str(wav_path),
        ],
        check=True,
    )
    dur = ffprobe_duration(wav_path)
    return {
        **cue,
        "wav": str(wav_path),
        "duration": dur,
        "words": words,
    }


def read_wav_float32(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as wf:
        assert wf.getframerate() == 48000
        assert wf.getnchannels() == 2
        assert wf.getsampwidth() == 2
        raw = wf.readframes(wf.getnframes())
    arr = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    return arr.reshape(-1, 2)


def write_wav_int16(path: Path, samples: np.ndarray, sr: int = 48000) -> None:
    clipped = np.clip(samples, -0.99, 0.99)
    pcm = (clipped * 32767.0).astype(np.int16)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())


def generate_ambient_bed(total_dur: float, chapter_starts: list[float], sr: int = 48000) -> np.ndarray:
    """
    Ultra-clean, deeply warm institutional ambient bed (~-29 dB below voice).
    Strictly low-frequency harmonic warmth (<380 Hz) so it NEVER masks speech clarity.
    Includes subtle soft glass-chime cues on chapter transitions.
    """
    n = int(math.ceil(total_dur * sr))
    t = np.arange(n, dtype=np.float64) / sr

    # Subtle 4-bar chord progression (Dm9 -> Bbmaj7 -> Fmaj7 -> Csus2) looping gently every 24s
    chords = [
        (73.42, 110.00, 146.83, 174.61),   # D2 A2 D3 F3
        (58.27, 116.54, 146.83, 174.61),   # Bb1 Bb2 D3 F3
        (65.41, 130.81, 164.81, 196.00),   # C2 C3 E3 G3
        (82.41, 123.47, 164.81, 196.00),   # E2 B2 E3 G3
    ]
    bar_len = 6.0
    pad_l = np.zeros(n, dtype=np.float64)
    pad_r = np.zeros(n, dtype=np.float64)

    # Smooth crossfaded chord envelopes
    num_bars = int(math.ceil(total_dur / bar_len)) + 1
    for b in range(num_bars):
        chord = chords[b % len(chords)]
        start_t = b * bar_len
        end_t = (b + 1) * bar_len
        # overlap slightly for silky legato
        s0 = max(0, int((start_t - 0.8) * sr))
        s1 = min(n, int((end_t + 0.8) * sr))
        if s1 <= s0:
            continue
        seg_t = t[s0:s1]
        env = np.ones_like(seg_t)
        fade = 1.1
        rise = np.clip((seg_t - (start_t - 0.8)) / fade, 0.0, 1.0)
        fall = np.clip(((end_t + 0.8) - seg_t) / fade, 0.0, 1.0)
        env = (0.5 - 0.5 * np.cos(np.pi * rise)) * (0.5 - 0.5 * np.cos(np.pi * fall))
        # gentle breathing modulation
        lfo = 0.88 + 0.12 * np.sin(2.0 * np.pi * 0.17 * seg_t + b)
        for idx, freq in enumerate(chord):
            weight = [0.42, 0.28, 0.18, 0.12][idx]
            # slight stereo detune for rich studio width
            sig_l = np.sin(2.0 * np.pi * (freq * 0.9992) * seg_t)
            sig_r = np.sin(2.0 * np.pi * (freq * 1.0008) * seg_t)
            pad_l[s0:s1] += weight * env * lfo * sig_l
            pad_r[s0:s1] += weight * env * lfo * sig_r

    # Subtle soft chapter transition ping (only for chapters 2..5)
    for cs in chapter_starts[1:]:
        ping_len = int(1.1 * sr)
        s0 = int(cs * sr)
        s1 = min(n, s0 + ping_len)
        if s1 <= s0:
            continue
        pt = np.arange(s1 - s0, dtype=np.float64) / sr
        attack = np.clip(pt / 0.015, 0.0, 1.0)
        decay = np.exp(-pt * 4.5)
        ping = attack * decay * (0.55 * np.sin(2 * np.pi * 587.33 * pt) + 0.30 * np.sin(2 * np.pi * 880.0 * pt))
        pad_l[s0:s1] += 0.35 * ping
        pad_r[s0:s1] += 0.35 * ping

    # Master fade-in (1.5s) & fade-out (2.0s)
    fade_in = np.clip(t / 1.5, 0.0, 1.0)
    fade_out = np.clip((total_dur - t) / 2.0, 0.0, 1.0)
    master_env = (0.5 - 0.5 * np.cos(np.pi * fade_in)) * (0.5 - 0.5 * np.cos(np.pi * fade_out))

    # Keep bed super subtle (-28 dB relative to voice peak ~0.5)
    gain = 0.022
    stereo = np.stack([pad_l * master_env * gain, pad_r * master_env * gain], axis=1)
    return stereo.astype(np.float32)


def master_loudnorm(in_wav: Path, out_wav: Path, out_m4a: Path) -> dict:
    # Pass 1: measure EBU R128 loudness stats
    cmd1 = [
        FFMPEG,
        "-y",
        "-i",
        str(in_wav),
        "-af",
        "loudnorm=I=-14.0:TP=-1.2:LRA=7.0:print_format=json",
        "-f",
        "null",
        "-",
    ]
    res1 = subprocess.run(cmd1, capture_output=True, text=True, check=True)
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", res1.stderr, re.DOTALL)
    if not m:
        raise RuntimeError(f"Could not parse loudnorm pass-1 stats:\n{res1.stderr[-1200:]}")
    stats = json.loads(m.group(0))

    # Pass 2: linear two-pass normalization + brickwall true-peak safety
    af2 = (
        f"loudnorm=I=-14.0:TP=-1.2:LRA=7.0:linear=true:"
        f"measured_I={stats['input_i']}:measured_LRA={stats['input_lra']}:"
        f"measured_TP={stats['input_tp']}:measured_thresh={stats['input_thresh']}:"
        f"offset={stats['target_offset']},"
        f"aresample=48000"
    )
    subprocess.run(
        [FFMPEG, "-y", "-v", "error", "-i", str(in_wav), "-af", af2, "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", str(out_wav)],
        check=True,
    )
    subprocess.run(
        [
            FFMPEG,
            "-y",
            "-v",
            "error",
            "-i",
            str(out_wav),
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            "48000",
            "-ac",
            "2",
            str(out_m4a),
        ],
        check=True,
    )

    # Pass 3: verify final AAC integrated loudness
    cmd3 = [
        FFMPEG,
        "-y",
        "-i",
        str(out_m4a),
        "-af",
        "loudnorm=I=-14.0:TP=-1.2:LRA=7.0:print_format=json",
        "-f",
        "null",
        "-",
    ]
    res3 = subprocess.run(cmd3, capture_output=True, text=True, check=True)
    m3 = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", res3.stderr, re.DOTALL)
    final_stats = json.loads(m3.group(0)) if m3 else {}
    return {"pass1": stats, "final": final_stats}


async def main():
    print(f"Synthesizing {len(CUES)} cues with {VOICE} (rate={RATE})...")
    sem = asyncio.Semaphore(3)
    results = await asyncio.gather(*(synth_cue(c, sem) for c in CUES))

    lead_in = 0.40
    cur_t = lead_in
    timeline = []
    chapter_bounds = {}

    for item in results:
        ch = item["chapter"]
        start = cur_t
        end = start + item["duration"]
        if ch not in chapter_bounds:
            chapter_bounds[ch] = {"start": start if ch > 1 else 0.0, "end": end}
        chapter_bounds[ch]["end"] = end + item["pause_after"]

        timeline.append(
            {
                "id": item["id"],
                "chapter": ch,
                "scene": item["scene"],
                "start": round(start, 4),
                "end": round(end, 4),
                "duration": round(item["duration"], 4),
                "pause_after": item["pause_after"],
                "tts": item["tts"],
                "sub_lines": item["sub_lines"],
                "wav": item["wav"],
            }
        )
        cur_t = end + item["pause_after"]

    total_dur = round(cur_t, 3)
    chapter_bounds[5]["end"] = total_dur
    # Make chapter boundaries contiguous (next chapter starts exactly where previous ends)
    chapters_out = []
    for ch in CHAPTERS:
        cid = ch["id"]
        c_start = 0.0 if cid == 1 else chapter_bounds[cid - 1]["end"]
        c_end = chapter_bounds[cid]["end"]
        chapters_out.append({**ch, "start": round(c_start, 4), "end": round(c_end, 4)})

    print(f"Total timeline duration: {total_dur:.2f}s")
    for ch in chapters_out:
        print(f"  Ch {ch['id']} ({ch['short']}): {ch['start']:.2f}s -> {ch['end']:.2f}s ({ch['end'] - ch['start']:.2f}s)")

    # Assemble stereo 48kHz voice track + subtle ambient bed
    sr = 48000
    n_total = int(math.ceil(total_dur * sr))
    voice_buf = np.zeros((n_total, 2), dtype=np.float32)

    for item in timeline:
        samples = read_wav_float32(Path(item["wav"]))
        s0 = int(round(item["start"] * sr))
        s1 = min(n_total, s0 + len(samples))
        voice_buf[s0:s1] += samples[: s1 - s0]

    bed_buf = generate_ambient_bed(total_dur, [c["start"] for c in chapters_out], sr=sr)
    mixed = voice_buf + bed_buf[:n_total]

    raw_mix_wav = AUDIO_DIR / "mix_raw.wav"
    master_wav = AUDIO_DIR / "master_audio.wav"
    master_m4a = AUDIO_DIR / "master_audio.m4a"
    write_wav_int16(raw_mix_wav, mixed, sr=sr)

    loudness = master_loudnorm(raw_mix_wav, master_wav, master_m4a)
    actual_dur = ffprobe_duration(master_m4a)

    meta = {
        "voice": VOICE,
        "rate": RATE,
        "total_duration": round(actual_dur, 4),
        "timeline_duration": total_dur,
        "chapters": chapters_out,
        "cues": timeline,
        "loudness": loudness,
    }
    (AUDIO_DIR / "timeline.json").write_text(json.dumps(meta, indent=2))
    print(f"Mastered audio duration: {actual_dur:.3f}s")
    print(
        f"Final Loudness: I={loudness['final'].get('input_i')} LUFS, "
        f"TP={loudness['final'].get('input_tp')} dBTP, "
        f"LRA={loudness['final'].get('input_lra')} LU"
    )


if __name__ == "__main__":
    asyncio.run(main())
