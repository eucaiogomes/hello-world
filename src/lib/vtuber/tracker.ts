import {
  FaceLandmarker,
  PoseLandmarker,
  FilesetResolver,
  type FaceLandmarkerResult,
  type PoseLandmarkerResult,
} from "@mediapipe/tasks-vision";

export interface TrackingState {
  face: FaceLandmarkerResult | null;
  pose: PoseLandmarkerResult | null;
}

export class Tracker {
  private faceLandmarker: FaceLandmarker | null = null;
  private poseLandmarker: PoseLandmarker | null = null;
  private video: HTMLVideoElement;
  public state: TrackingState = { face: null, pose: null };
  private running = false;

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  async init() {
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
    );

    this.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });

    this.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numPoses: 1,
    });
  }

  start() {
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      if (this.video.readyState >= 2 && this.faceLandmarker && this.poseLandmarker) {
        const ts = performance.now();
        try {
          this.state.face = this.faceLandmarker.detectForVideo(this.video, ts);
          this.state.pose = this.poseLandmarker.detectForVideo(this.video, ts);
        } catch {
          /* skip frame */
        }
      }
      requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    this.running = false;
  }
}
