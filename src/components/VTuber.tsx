import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { Tracker } from "@/lib/vtuber/tracker";
import { VRMRig } from "@/lib/vtuber/rig";
import { Button } from "@/components/ui/button";
import { Upload, Camera, CameraOff } from "lucide-react";
import { toast } from "sonner";

const DEFAULT_VRM_URL = "/avatar.vrm";

export const VTuber = () => {
  const mountRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const vrmRef = useRef<VRM | null>(null);
  const rigRef = useRef<VRMRig | null>(null);
  const trackerRef = useRef<Tracker | null>(null);
  const clockRef = useRef(new THREE.Clock());

  const [status, setStatus] = useState("Initializing scene...");
  const [cameraOn, setCameraOn] = useState(false);
  const [fps, setFps] = useState(0);

  // Init three scene
  useEffect(() => {
    const mount = mountRef.current!;
    const width = mount.clientWidth;
    const height = mount.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x00ff00); // chroma green
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 20);
    camera.position.set(0, 1.4, 1.6);
    camera.lookAt(0, 1.3, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const dir = new THREE.DirectionalLight(0xffffff, 1);
    dir.position.set(1, 2, 1);
    scene.add(dir);
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));

    let frames = 0;
    let lastFpsT = performance.now();

    const animate = () => {
      const dt = clockRef.current.getDelta();
      const tracker = trackerRef.current;
      const rig = rigRef.current;
      if (rig) {
        rig.update(tracker?.state.face ?? null, tracker?.state.pose ?? null, dt);
      }
      renderer.render(scene, camera);

      frames++;
      const now = performance.now();
      if (now - lastFpsT >= 1000) {
        setFps(frames);
        frames = 0;
        lastFpsT = now;
      }
      requestAnimationFrame(animate);
    };
    animate();

    const onResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);

    // Try loading default avatar
    loadVrmFromUrl(DEFAULT_VRM_URL).catch(() => {
      setStatus("No default avatar found. Click 'Load VRM' to upload one.");
    });

    return () => {
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadVrmFromUrl = useCallback(async (url: string) => {
    setStatus("Loading avatar...");
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const vrm: VRM = gltf.userData.vrm;
    if (!vrm) throw new Error("Not a VRM file");
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.removeUnnecessaryJoints(gltf.scene);
    vrm.scene.traverse((o) => ((o as THREE.Mesh).frustumCulled = false));

    // Replace existing
    if (vrmRef.current) {
      sceneRef.current?.remove(vrmRef.current.scene);
      VRMUtils.deepDispose(vrmRef.current.scene);
    }
    sceneRef.current!.add(vrm.scene);
    vrm.scene.rotation.y = Math.PI; // face camera
    vrmRef.current = vrm;
    rigRef.current = new VRMRig(vrm);
    setStatus("Avatar loaded. Start camera to begin tracking.");
    toast.success("Avatar loaded");
  }, []);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    try {
      await loadVrmFromUrl(url);
    } catch (err) {
      console.error(err);
      toast.error("Failed to load VRM file");
      setStatus("Failed to load VRM file.");
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const startCamera = async () => {
    try {
      setStatus("Starting webcam...");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" },
        audio: false,
      });
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();

      setStatus("Loading tracking models (first time can take a few seconds)...");
      const tracker = new Tracker(video);
      await tracker.init();
      tracker.start();
      trackerRef.current = tracker;
      setCameraOn(true);
      setStatus("Tracking active.");
      toast.success("Tracking started");
    } catch (err) {
      console.error(err);
      toast.error("Could not start camera");
      setStatus("Camera failed. Check permissions.");
    }
  };

  const stopCamera = () => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    const video = videoRef.current;
    const stream = video?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
    if (video) video.srcObject = null;
    setCameraOn(false);
    setStatus("Tracking stopped.");
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-background">
      <div ref={mountRef} className="absolute inset-0" />
      <video ref={videoRef} className="hidden" playsInline muted />

      {/* HUD */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-between p-4">
        <div className="pointer-events-auto rounded-md bg-card/80 px-3 py-2 text-sm text-card-foreground backdrop-blur">
          <div className="font-semibold">VTuber Studio</div>
          <div className="text-muted-foreground">{status}</div>
        </div>
        <div className="pointer-events-auto rounded-md bg-card/80 px-3 py-2 text-sm text-card-foreground backdrop-blur">
          {fps} FPS
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center gap-2 p-4">
        <div className="pointer-events-auto flex gap-2 rounded-lg bg-card/80 p-2 backdrop-blur">
          <input
            ref={fileInputRef}
            type="file"
            accept=".vrm"
            className="hidden"
            onChange={onFile}
          />
          <Button variant="secondary" onClick={() => fileInputRef.current?.click()}>
            <Upload className="mr-2 h-4 w-4" />
            Load VRM
          </Button>
          {!cameraOn ? (
            <Button onClick={startCamera}>
              <Camera className="mr-2 h-4 w-4" />
              Start Tracking
            </Button>
          ) : (
            <Button variant="destructive" onClick={stopCamera}>
              <CameraOff className="mr-2 h-4 w-4" />
              Stop Tracking
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default VTuber;
