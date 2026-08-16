import { motion, AnimatePresence } from 'framer-motion';
import { useVideoPlayer } from '@/lib/video';
import { SceneHook } from './video_scenes/SceneHook';
import { SceneInput } from './video_scenes/SceneInput';
import { SceneCoding } from './video_scenes/SceneCoding';
import { SceneRunning } from './video_scenes/SceneRunning';
import { SceneDeploy } from './video_scenes/SceneDeploy';
import { SceneClose } from './video_scenes/SceneClose';

const SCENE_DURATIONS = {
  hook: 5000,
  input: 10000,
  coding: 10000,
  running: 10000,
  deploy: 12000,
  close: 3000
};

export default function VideoTemplate() {
  const { currentScene } = useVideoPlayer({ durations: SCENE_DURATIONS });

  return (
    <div className="relative w-full h-[100vh] overflow-hidden bg-brand-bg font-display flex items-center justify-center">
      {/* Persistent Background Layer */}
      <div className="absolute inset-0 z-0">
        <video 
          src={`${import.meta.env.BASE_URL}generated_images/background_video.mp4`}
          className="absolute inset-0 w-full h-full object-cover opacity-30 mix-blend-screen"
          autoPlay muted loop playsInline
        />
        <div className="absolute inset-0 dot-grid opacity-20 pointer-events-none" />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-brand-bg/80 pointer-events-none" />
      </div>
      
      {/* Persistent Horizontal Accent Line */}
      <motion.div 
        className="absolute top-0 left-0 right-0 h-1 bg-brand-primary z-50 origin-left"
        animate={{
          scaleX: [0, 1, 1, 1, 1, 0][currentScene],
          opacity: [0.8, 1, 0.8, 1, 0.8, 0][currentScene]
        }}
        transition={{ duration: 1.5, ease: "easeInOut" }}
      />
      
      {/* Foreground Content */}
      <div className="relative z-10 w-full h-full">
        <AnimatePresence mode="sync">
          {currentScene === 0 && <SceneHook key="hook" />}
          {currentScene === 1 && <SceneInput key="input" />}
          {currentScene === 2 && <SceneCoding key="coding" />}
          {currentScene === 3 && <SceneRunning key="running" />}
          {currentScene === 4 && <SceneDeploy key="deploy" />}
          {currentScene === 5 && <SceneClose key="close" />}
        </AnimatePresence>
      </div>
    </div>
  );
}
