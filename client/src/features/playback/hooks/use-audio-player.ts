/**
 * Web Audio–based playback for instrumental + guide vocals, with a shared
 * rAF tick that notifies subscribers for visuals (background sync, lyrics, HUD).
 * The returned API object is referentially stable across renders when its fields are unchanged.
 *
 * Graph: instrumental buffer → instrumental gain → master gain → destination;
 * vocals buffer → guide gain → master gain.
 * Playback position is derived from AudioContext.currentTime and a (offset, contextTimeAtStart)
 * pair because BufferSourceNode is one-shot: pause/seek recreate sources rather than mutating time.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { PlaybackAdapter } from '@/bridge/playback';
import { playbackAdapter } from '@/bridge/playback';
import { t } from '@/i18n';

export type TimeSubscriber = (time: number) => void;

type InitialVolumes = {
  guide: number;
  master: number;
};

export type AudioPlayer = {
  getCurrentTime: () => number;
  subscribe: (fn: TimeSubscriber) => () => void;
  duration: number;
  isReady: boolean;
  isPlaying: boolean;
  isFinished: boolean;
  error: string | null;
  guideVolume: number;
  vocalsOnly: boolean;
  /** False for LRC-provided songs without stems: the original mix plays and
   * there is no separate guide vocal track to control. */
  guideAvailable: boolean;
  play: () => void;
  pause: () => void;
  resume: () => void;
  seek: (time: number) => void;
  setGuideVolume: (v: number) => void;
  setVocalsOnly: (enabled: boolean) => void;
  cleanup: () => void;
  getVocalsBuffer: () => AudioBuffer | null;
  getScoringBuffer: () => AudioBuffer | null;
  getAudioContext: () => AudioContext | null;
};

export function useAudioPlayer(
  fileHash: string,
  initialVolumes: InitialVolumes,
  enabled: boolean,
  adapter: PlaybackAdapter = playbackAdapter,
): AudioPlayer {
  const { guide: initialGuideVolume, master: initialMasterVolume } = initialVolumes;
  const ctxRef = useRef<AudioContext | null>(null);
  const instrumentalBufRef = useRef<AudioBuffer | null>(null);
  const vocalsBufRef = useRef<AudioBuffer | null>(null);
  const instrumentalSrcRef = useRef<AudioBufferSourceNode | null>(null);
  const vocalsSrcRef = useRef<AudioBufferSourceNode | null>(null);
  const vocalsGainRef = useRef<GainNode | null>(null);
  const instrumentalGainRef = useRef<GainNode | null>(null);
  const restoreGuideVolumeRef = useRef<number | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const rafRef = useRef<number>(0);
  const currentTimeRef = useRef(0);
  const subscribersRef = useRef<Set<TimeSubscriber>>(new Set());
  /** Logical playback position (seconds) when the current sources were started. */
  const startOffsetRef = useRef(0);
  /** ctx.currentTime at the moment the current sources started (anchors wall-clock math). */
  const startContextTimeRef = useRef(0);
  const playingRef = useRef(false);
  /** Set on cleanup so async decode/start and onended ignore stale work after unmount. */
  const cancelledRef = useRef(false);

  const [duration, setDuration] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFinished, setIsFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guideVolume, setGuideVolumeState] = useState(initialGuideVolume);
  const [vocalsOnly, setVocalsOnlyState] = useState(false);
  const [guideAvailable, setGuideAvailable] = useState(true);

  const getVocalsBuffer = useCallback(() => vocalsBufRef.current, []);

  const getScoringBuffer = useCallback(
    () => vocalsBufRef.current ?? instrumentalBufRef.current,
    [],
  );

  const getAudioContext = useCallback(() => ctxRef.current, []);

  const getCurrentTime = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx || !playingRef.current) {
      return currentTimeRef.current;
    }

    return startOffsetRef.current + (ctx.currentTime - startContextTimeRef.current);
  }, []);

  const subscribe = useCallback((fn: TimeSubscriber) => {
    subscribersRef.current.add(fn);

    return () => {
      subscribersRef.current.delete(fn);
    };
  }, []);

  const notifySubscribers = useCallback((currentTime: number) => {
    for (const fn of subscribersRef.current) {
      fn(currentTime);
    }
  }, []);

  const stopSources = useCallback(() => {
    playingRef.current = false;

    try {
      instrumentalSrcRef.current?.stop();
    } catch {
      /* BufferSourceNode throws if stopped twice */
    }
    try {
      vocalsSrcRef.current?.stop();
    } catch {
      /* BufferSourceNode throws if stopped twice */
    }

    instrumentalSrcRef.current = null;
    vocalsSrcRef.current = null;
  }, []);

  const startSources = useCallback(
    (offset: number) => {
      const ctx = ctxRef.current;
      const instBuf = instrumentalBufRef.current;
      const vocBuf = vocalsBufRef.current;
      const gainNode = vocalsGainRef.current;
      const instrumentalGainNode = instrumentalGainRef.current;
      const masterGainNode = masterGainRef.current;

      if (!ctx || !instBuf || !masterGainNode || !instrumentalGainNode) {
        return;
      }

      stopSources();

      const clamped = Math.max(0, Math.min(offset, instBuf.duration));

      const instSrc = ctx.createBufferSource();
      instSrc.buffer = instBuf;
      instSrc.connect(instrumentalGainNode);

      instSrc.addEventListener(
        'ended',
        () => {
          if (
            !cancelledRef.current &&
            playingRef.current &&
            instrumentalSrcRef.current === instSrc
          ) {
            playingRef.current = false;

            setIsFinished(true);
            setIsPlaying(false);
          }
        },
        { once: true },
      );

      startOffsetRef.current = clamped;
      startContextTimeRef.current = ctx.currentTime;

      instSrc.start(0, clamped);
      instrumentalSrcRef.current = instSrc;

      // No vocals stem (LRC-provided, no separation): play the original mix
      // through the instrumental node only.
      if (vocBuf && gainNode) {
        const vocSrc = ctx.createBufferSource();
        vocSrc.buffer = vocBuf;
        vocSrc.connect(gainNode);
        vocSrc.start(0, clamped);
        vocalsSrcRef.current = vocSrc;
      }

      playingRef.current = true;
    },
    [stopSources],
  );

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    let cancelled = false;

    cancelledRef.current = false;
    playingRef.current = false;

    startOffsetRef.current = 0;
    startContextTimeRef.current = 0;
    currentTimeRef.current = 0;

    const ctx = new AudioContext();
    ctxRef.current = ctx;

    const masterGainNode = ctx.createGain();
    masterGainNode.gain.value = Math.max(0, Math.min(1, initialMasterVolume));
    masterGainNode.connect(ctx.destination);
    masterGainRef.current = masterGainNode;

    const instrumentalGainNode = ctx.createGain();
    instrumentalGainNode.connect(masterGainNode);
    instrumentalGainRef.current = instrumentalGainNode;

    const gainNode = ctx.createGain();
    gainNode.gain.value = Math.max(0, Math.min(1, initialGuideVolume));
    gainNode.connect(masterGainNode);
    vocalsGainRef.current = gainNode;

    const isCancelled = () => cancelled || cancelledRef.current;

    adapter
      .getAudioPaths(fileHash)
      .then(async (paths) => {
        if (isCancelled()) {
          return undefined;
        }

        const vocalsUrl = paths.vocals;
        setGuideAvailable(vocalsUrl !== null);

        const [instData, vocData] = await Promise.all([
          fetch(paths.instrumental).then((r) => {
            if (!r.ok) {
              throw new Error(t('playback.audio.instrumentalFetchError', { status: r.status }));
            }

            return r.arrayBuffer();
          }),

          vocalsUrl === null
            ? Promise.resolve(null)
            : fetch(vocalsUrl).then((r) => {
                if (!r.ok) {
                  throw new Error(t('playback.audio.vocalsFetchError', { status: r.status }));
                }

                return r.arrayBuffer();
              }),
        ]);

        if (isCancelled()) {
          return undefined;
        }

        if (ctx.state === 'suspended') {
          await ctx.resume();
        }

        const [instBuf, vocBuf] = await Promise.all([
          ctx.decodeAudioData(instData),
          vocData === null ? Promise.resolve(null) : ctx.decodeAudioData(vocData),
        ]);

        if (isCancelled()) {
          return undefined;
        }

        instrumentalBufRef.current = instBuf;
        vocalsBufRef.current = vocBuf;

        setDuration(instBuf.duration);
        setIsReady(true);
        return undefined;
      })
      .catch((e: unknown) => {
        if (!isCancelled()) {
          setError(
            t('playback.audio.loadError', {
              error: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      });

    let lastNotify = 0;
    const NOTIFY_INTERVAL = 33;

    const tick = () => {
      if (isCancelled()) {
        return;
      }

      if (playingRef.current && ctxRef.current) {
        const now = performance.now();
        const currentTime =
          startOffsetRef.current + (ctxRef.current.currentTime - startContextTimeRef.current);
        currentTimeRef.current = currentTime;

        if (now - lastNotify >= NOTIFY_INTERVAL) {
          lastNotify = now;
          for (const fn of subscribersRef.current) {
            fn(currentTime);
          }
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      stopSources();
      instrumentalBufRef.current = null;
      vocalsBufRef.current = null;
      vocalsGainRef.current = null;
      instrumentalGainRef.current = null;
      masterGainRef.current = null;
      if (ctxRef.current === ctx) {
        void ctx.close();
        ctxRef.current = null;
      }
    };
  }, [adapter, enabled, fileHash, initialGuideVolume, initialMasterVolume, stopSources]);

  const play = useCallback(() => {
    if (playingRef.current) {
      return;
    }
    startSources(startOffsetRef.current);
    setIsPlaying(playingRef.current);
  }, [startSources]);

  const pause = useCallback(() => {
    const ctx = ctxRef.current;
    if (ctx && playingRef.current) {
      startOffsetRef.current += ctx.currentTime - startContextTimeRef.current;
    }

    stopSources();
    setIsPlaying(false);
  }, [stopSources]);

  const resume = useCallback(() => {
    startSources(startOffsetRef.current);
    setIsPlaying(true);
  }, [startSources]);

  const seek = useCallback(
    (time: number) => {
      const wasPlaying = playingRef.current;

      stopSources();

      startOffsetRef.current = time;
      currentTimeRef.current = time;

      if (wasPlaying) {
        startSources(time);
        setIsPlaying(true);
      }

      notifySubscribers(time);
      setIsFinished(false);
    },
    [stopSources, startSources, notifySubscribers],
  );

  const setGuideVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v));

    restoreGuideVolumeRef.current = null;
    setGuideVolumeState(clamped);

    if (vocalsGainRef.current) {
      vocalsGainRef.current.gain.value = clamped;
    }
  }, []);

  const setVocalsOnly = useCallback(
    (vocalsOnlyEnabled: boolean) => {
      if (vocalsOnlyEnabled && guideVolume === 0) {
        setGuideVolume(0.3);
        restoreGuideVolumeRef.current = 0;
      } else if (!vocalsOnlyEnabled && restoreGuideVolumeRef.current !== null) {
        setGuideVolume(restoreGuideVolumeRef.current);
      }
      setVocalsOnlyState(vocalsOnlyEnabled);
      const gain = instrumentalGainRef.current?.gain;
      const ctx = ctxRef.current;
      if (gain && ctx) {
        gain.cancelScheduledValues(ctx.currentTime);
        gain.setValueAtTime(gain.value, ctx.currentTime);
        gain.linearRampToValueAtTime(vocalsOnlyEnabled ? 0 : 1, ctx.currentTime + 0.02);
      }
    },
    [guideVolume, setGuideVolume],
  );

  const cleanup = useCallback(() => {
    cancelledRef.current = true;

    cancelAnimationFrame(rafRef.current);

    stopSources();

    void ctxRef.current?.close();
    ctxRef.current = null;
  }, [stopSources]);

  return useMemo(
    () => ({
      getCurrentTime,
      subscribe,
      duration,
      isReady,
      isPlaying,
      isFinished,
      error,
      guideVolume,
      vocalsOnly,
      guideAvailable,
      play,
      pause,
      resume,
      seek,
      setGuideVolume,
      setVocalsOnly,
      cleanup,
      getVocalsBuffer,
      getScoringBuffer,
      getAudioContext,
    }),
    [
      getCurrentTime,
      subscribe,
      duration,
      isReady,
      isPlaying,
      isFinished,
      error,
      guideVolume,
      vocalsOnly,
      guideAvailable,
      play,
      pause,
      resume,
      seek,
      setGuideVolume,
      setVocalsOnly,
      cleanup,
      getVocalsBuffer,
      getScoringBuffer,
      getAudioContext,
    ],
  );
}
