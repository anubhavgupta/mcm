import type { ThemeId } from './themes';

export interface NativeInferenceOptions {
  width: number;
  height: number;
  theme: ThemeId;
}
export interface NativeInferenceState { open: boolean }
export interface NativeInferenceDrag {
  phase: 'start' | 'move' | 'end';
  screenX: number;
  screenY: number;
}
export interface InferenceWindowBindings {
  mcmDragInference(drag: NativeInferenceDrag): Promise<void>;
}
export interface DesktopInferenceBindings {
  mcmOpenInference(options: NativeInferenceOptions): Promise<NativeInferenceState>;
  mcmCloseInference(): Promise<NativeInferenceState>;
  mcmInferenceState(): Promise<NativeInferenceState>;
  mcmSetInferenceTheme(theme: ThemeId): Promise<void>;
  mcmGetInferenceTheme(): Promise<ThemeId>;
}
