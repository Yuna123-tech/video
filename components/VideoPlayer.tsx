import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Scene, AspectRatio, SubtitleMode, PresenterSettings } from '../types';
import { Play, Pause, SkipBack, SkipForward, Languages, Subtitles } from 'lucide-react';
import { buildTimeline, findCue } from '../services/subtitleUtils';
import { needsLetterbox } from '../services/recorderService';
import { poseUrl, showsPresenter } from '../services/presenterService';

interface VideoPlayerProps {
  scenes: Scene[];
  aspectRatio: AspectRatio;
  subtitleMode?: SubtitleMode;
  onSubtitleModeChange?: (mode: SubtitleMode) => void;
  bgmUrl?: string | null;
  bgmVolume?: number;
  presenter?: PresenterSettings;
}

// Talking bounce for the presenter while narration plays (the exported video syncs it to the voice volume)
const PRESENTER_CSS = `
@keyframes presenter-talk {
  0%, 100% { transform: translateY(0) rotate(-0.6deg) scale(1); }
  25% { transform: translateY(-2.5%) rotate(0.5deg) scale(1.015); }
  50% { transform: translateY(-0.5%) rotate(0.8deg) scale(1.005); }
  75% { transform: translateY(-2%) rotate(-0.4deg) scale(1.012); }
}
@keyframes presenter-idle {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-0.6%); }
}`;

export const VideoPlayer: React.FC<VideoPlayerProps> = ({ 
  scenes, 
  aspectRatio, 
  subtitleMode = 'dual',
  onSubtitleModeChange,
  bgmUrl,
  bgmVolume = 0.15,
  presenter
}) => {
  const [currentSceneIndex, setCurrentSceneIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [localTime, setLocalTime] = useState(0);

  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const bgmRef = useRef<HTMLAudioElement>(null);
  
  const timeline = useMemo(() => buildTimeline(scenes, aspectRatio), [scenes, aspectRatio]);
  const currentEntry = timeline[currentSceneIndex];
  const currentScene = currentEntry?.scene;
  const cue = currentEntry ? findCue(currentEntry.cues, localTime) : undefined;

  // Reset only when the set of scenes changes, not on every text edit
  const sceneCount = scenes.length;
  useEffect(() => {
    setCurrentSceneIndex(0);
    setIsPlaying(false);
    setLocalTime(0);
  }, [sceneCount]);

  useEffect(() => { setLocalTime(0); }, [currentSceneIndex]);

  const goNext = () => {
    if (currentSceneIndex < scenes.length - 1) {
      setCurrentSceneIndex(prev => prev + 1);
    } else {
      setIsPlaying(false);
      setCurrentSceneIndex(0);
      if (bgmRef.current) bgmRef.current.currentTime = 0;
    }
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) setLocalTime(audioRef.current.currentTime);
  };

  // Smooth subtitle updates while audio plays (timeupdate fires only ~4x/sec)
  useEffect(() => {
    if (!isPlaying || !currentScene?.audioUrl) return;
    let raf = 0;
    const tick = () => {
      if (audioRef.current) setLocalTime(audioRef.current.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, currentScene?.audioUrl]);

  // Scenes without audio yet: advance on a timer using the estimated duration
  useEffect(() => {
    if (!isPlaying || currentScene?.audioUrl) return;
    const started = performance.now() - localTime * 1000;
    const id = setInterval(() => {
      const t = (performance.now() - started) / 1000;
      setLocalTime(t);
      if (t >= (currentScene?.duration || 4)) {
        clearInterval(id);
        goNext();
      }
    }, 50);
    return () => clearInterval(id);
  }, [isPlaying, currentSceneIndex, currentScene?.audioUrl]);

  useEffect(() => {
    if (isPlaying) {
       audioRef.current?.play().catch(() => {});
       videoRef.current?.play().catch(() => {});
       bgmRef.current?.play().catch(() => {});
    } else {
       audioRef.current?.pause();
       videoRef.current?.pause();
       bgmRef.current?.pause();
    }
  }, [currentSceneIndex, isPlaying, currentScene?.audioUrl]);

  useEffect(() => {
    if (bgmRef.current) bgmRef.current.volume = Math.max(0, Math.min(1, bgmVolume));
  }, [bgmVolume, bgmUrl]);

  // Photos whose ratio is far from the frame get a blurred fill instead of a harsh crop (same rule as the renderer)
  const [letterbox, setLetterbox] = useState(false);
  useEffect(() => { setLetterbox(false); }, [currentScene?.imageUrl]);
  const frameAspect = aspectRatio === AspectRatio.Shorts ? 9 / 16 : aspectRatio === AspectRatio.Square ? 1 : 16 / 9;
  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalWidth && needsLetterbox(img.naturalWidth / img.naturalHeight, frameAspect)) setLetterbox(true);
  };

  const togglePlay = () => setIsPlaying(!isPlaying);

  const getContainerStyle = () => {
    switch(aspectRatio) {
        case AspectRatio.Shorts: return 'aspect-[9/16]';
        case AspectRatio.Landscape: return 'aspect-[16/9]';
        case AspectRatio.Square: return 'aspect-square';
        default: return 'aspect-video';
    }
  };

  const hasPresenter = !!(presenter && currentScene && showsPresenter(currentScene, presenter));
  const presenterOnLeft = presenter?.position !== 'right';

  // Same placement rules as the exported video: beside the presenter (landscape) or above it (portrait)
  const getSubtitlePositionClass = () => {
    if (aspectRatio === AspectRatio.Shorts) return hasPresenter ? 'bottom-[31%]' : 'bottom-[20%]';
    if (!hasPresenter) return 'bottom-[12%]';
    return presenterOnLeft ? 'bottom-[12%] pl-[32%]' : 'bottom-[12%] pr-[32%]';
  };

  if (!scenes.length) {
    return (
      <div className={`w-full max-w-md mx-auto bg-black rounded-lg flex items-center justify-center text-gray-500 border-2 border-dashed border-gray-700 ${getContainerStyle()}`}>
        <p>미리보기 준비 중...</p>
      </div>
    );
  }

  const showKo = (subtitleMode === 'dual' || subtitleMode === 'ko') && !!cue?.ko;
  const showEn = (subtitleMode === 'dual' || subtitleMode === 'en') && !!(cue?.en || (subtitleMode === 'en' && cue?.ko));

  return (
    <div className="flex flex-col items-center gap-4 w-full">
      <div className={`relative w-full max-w-lg overflow-hidden rounded-2xl shadow-2xl bg-black group border border-gray-800 ${getContainerStyle()}`}>
        
        {currentScene?.videoUrl ? (
             <video 
                ref={videoRef}
                src={currentScene.videoUrl}
                className="w-full h-full object-cover"
                loop
                muted
                playsInline
             />
        ) : (
             currentScene?.imageUrl ? (
                letterbox ? (
                  <div key={currentSceneIndex} className="relative w-full h-full overflow-hidden">
                    <img src={currentScene.imageUrl} className="absolute inset-0 w-full h-full object-cover scale-110 blur-2xl brightness-50" />
                    <img src={currentScene.imageUrl} className="relative w-full h-full object-contain drop-shadow-2xl" />
                  </div>
                ) : (
                  <img 
                    key={currentSceneIndex}
                    src={currentScene.imageUrl} 
                    onLoad={handleImageLoad}
                    style={{ objectPosition: `${(currentScene.focusX ?? 0.5) * 100}% ${(currentScene.focusY ?? 0.5) * 100}%`, transformOrigin: `${(currentScene.focusX ?? 0.5) * 100}% ${(currentScene.focusY ?? 0.5) * 100}%` }}
                    className="w-full h-full object-cover animate-pan-zoom"
                  />
                )
              ) : (
                <div className="w-full h-full bg-gray-900 flex items-center justify-center">
                  <span className="text-gray-500">생성 중...</span>
                </div>
              )
        )}

        {/* Presenter character */}
        {hasPresenter && presenter?.asset && (
          <>
            <style>{PRESENTER_CSS}</style>
            <img
              src={poseUrl(presenter.asset, currentScene.pose)}
              className={`absolute z-10 pointer-events-none object-contain ${presenterOnLeft ? 'left-[2.5%]' : 'right-[2.5%]'} ${
                aspectRatio === AspectRatio.Shorts ? 'h-[27%] max-w-[45%]' : 'h-[50%] max-w-[30%]'
              } ${presenter.asset.isCutout ? 'bottom-0 drop-shadow-2xl' : 'bottom-[4%] rounded-xl border-4 border-white shadow-2xl'}`}
              style={{
                transformOrigin: 'bottom center',
                animation: isPlaying && currentScene.audioUrl ? 'presenter-talk 0.45s ease-in-out infinite' : 'presenter-idle 3s ease-in-out infinite',
              }}
            />
          </>
        )}

        {/* Dynamic High-Legibility Subtitle Pill */}
        {subtitleMode !== 'none' && (showKo || showEn) && (
          <div className={`absolute ${getSubtitlePositionClass()} left-0 right-0 flex flex-col items-center pointer-events-none px-4 z-20`}>
            <div className="bg-black/85 border border-white/10 backdrop-blur-md px-4 py-2 rounded-2xl shadow-2xl flex flex-col items-center gap-1 max-w-[92%] transition-all duration-200">
              {showKo && (
                <span className="text-white text-xs sm:text-sm md:text-[15px] font-bold leading-snug break-keep text-center">
                  {cue?.ko}
                </span>
              )}
              {showEn && (
                <span className="text-yellow-300 text-[11px] sm:text-xs font-semibold leading-tight break-keep text-center tracking-wide">
                  {cue?.en || cue?.ko}
                </span>
              )}
            </div>
          </div>
        )}

        <audio 
            ref={audioRef}
            src={currentScene?.audioUrl}
            onEnded={goNext}
            onTimeUpdate={handleTimeUpdate}
            className="hidden"
        />
        {bgmUrl && <audio ref={bgmRef} src={bgmUrl} loop className="hidden" />}

        {!isPlaying && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/30 cursor-pointer z-30 transition-all hover:bg-black/20" onClick={togglePlay}>
                <div className="bg-primary-600/90 text-white p-4 rounded-full shadow-xl hover:scale-110 transition-transform">
                    <Play className="w-7 h-7 fill-white translate-x-0.5" />
                </div>
            </div>
        )}
      </div>

      {/* Playback Controls & Subtitle Mode Quick Selector */}
      <div className="flex flex-col sm:flex-row items-center gap-3 w-full max-w-lg justify-between">
        {/* Subtitle Mode Selector */}
        {onSubtitleModeChange && (
          <div className="flex items-center gap-1 bg-gray-900/90 p-1 rounded-xl border border-gray-800 text-xs">
            <span className="text-gray-400 px-2 flex items-center gap-1 text-[11px]">
              <Subtitles size={13} className="text-primary-400" /> 자막:
            </span>
            <button
              onClick={() => onSubtitleModeChange('dual')}
              className={`px-2 py-1 rounded-lg transition font-medium ${subtitleMode === 'dual' ? 'bg-primary-600 text-white' : 'text-gray-400 hover:text-white'}`}
              title="한글 음성과 영어 자막 동시 표시"
            >
              한/영 동시
            </button>
            <button
              onClick={() => onSubtitleModeChange('en')}
              className={`px-2 py-1 rounded-lg transition font-medium ${subtitleMode === 'en' ? 'bg-primary-600 text-white' : 'text-gray-400 hover:text-white'}`}
              title="영어 자막만 표시"
            >
              영어만
            </button>
            <button
              onClick={() => onSubtitleModeChange('ko')}
              className={`px-2 py-1 rounded-lg transition font-medium ${subtitleMode === 'ko' ? 'bg-primary-600 text-white' : 'text-gray-400 hover:text-white'}`}
              title="한글 자막만 표시"
            >
              한글만
            </button>
            <button
              onClick={() => onSubtitleModeChange('none')}
              className={`px-2 py-1 rounded-lg transition font-medium ${subtitleMode === 'none' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}
              title="자막 끄기"
            >
              숨김
            </button>
          </div>
        )}

        {/* Transport Controls */}
        <div className="flex items-center gap-3 bg-gray-900/90 px-4 py-1.5 rounded-xl shadow-lg border border-gray-800 ml-auto">
          <button onClick={() => { setIsPlaying(false); setCurrentSceneIndex(Math.max(0, currentSceneIndex - 1)); }} className="text-gray-400 hover:text-white transition p-1"><SkipBack size={18} /></button>
          <button onClick={togglePlay} className="bg-primary-600 hover:bg-primary-500 text-white p-2 rounded-full shadow transition transform hover:scale-105">
              {isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
          </button>
          <button onClick={() => { setIsPlaying(false); setCurrentSceneIndex(Math.min(scenes.length - 1, currentSceneIndex + 1)); }} className="text-gray-400 hover:text-white transition p-1"><SkipForward size={18} /></button>
          <div className="h-4 w-px bg-gray-700 mx-1"></div>
          <span className="text-xs text-gray-400 font-mono">{currentSceneIndex + 1} / {scenes.length}</span>
        </div>
      </div>
    </div>
  );
};