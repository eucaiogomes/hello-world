import * as THREE from "three";
import { VRM, VRMHumanBoneName, VRMExpressionPresetName } from "@pixiv/three-vrm";
import type { FaceLandmarkerResult, PoseLandmarkerResult } from "@mediapipe/tasks-vision";

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, mn: number, mx: number) => Math.max(mn, Math.min(mx, v));

interface SmoothBone {
  q: THREE.Quaternion;
}

export class VRMRig {
  private vrm: VRM;
  private smoothing = 0.35;
  private smoothBones: Partial<Record<VRMHumanBoneName, SmoothBone>> = {};
  private smoothExpr: Record<string, number> = {};
  private restPose: Partial<Record<VRMHumanBoneName, THREE.Quaternion>> = {};

  constructor(vrm: VRM) {
    this.vrm = vrm;
    // Cache rest pose
    const bones: VRMHumanBoneName[] = [
      "hips", "spine", "chest", "neck", "head",
      "leftUpperArm", "leftLowerArm",
      "rightUpperArm", "rightLowerArm",
      "leftUpperLeg", "leftLowerLeg",
      "rightUpperLeg", "rightLowerLeg",
    ];
    for (const name of bones) {
      const node = vrm.humanoid?.getNormalizedBoneNode(name);
      if (node) this.restPose[name] = node.quaternion.clone();
    }
  }

  private setBone(name: VRMHumanBoneName, target: THREE.Quaternion) {
    const node = this.vrm.humanoid?.getNormalizedBoneNode(name);
    if (!node) return;
    if (!this.smoothBones[name]) {
      this.smoothBones[name] = { q: node.quaternion.clone() };
    }
    const sb = this.smoothBones[name]!;
    sb.q.slerp(target, this.smoothing);
    node.quaternion.copy(sb.q);
  }

  private setExpr(name: string, target: number) {
    const cur = this.smoothExpr[name] ?? 0;
    const next = lerp(cur, target, 0.5);
    this.smoothExpr[name] = next;
    this.vrm.expressionManager?.setValue(name, next);
  }

  update(face: FaceLandmarkerResult | null, pose: PoseLandmarkerResult | null, dt: number) {
    this.applyFace(face);
    this.applyPose(pose);
    this.vrm.expressionManager?.update();
    this.vrm.update(dt);
  }

  private applyFace(face: FaceLandmarkerResult | null) {
    if (!face) return;

    // Head rotation from facial transformation matrix
    const mats = face.facialTransformationMatrixes;
    if (mats && mats.length > 0) {
      const m = new THREE.Matrix4().fromArray(mats[0].data);
      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      // MediaPipe coordinate fix: invert X & Z for mirror-like motion
      const headQ = new THREE.Quaternion(-q.x, q.y, -q.z, q.w);
      const rest = this.restPose["head"] ?? new THREE.Quaternion();
      const target = rest.clone().multiply(headQ);
      this.setBone("head", target);
    }

    // Blendshapes
    const bs = face.faceBlendshapes?.[0]?.categories;
    if (bs) {
      const map: Record<string, number> = {};
      for (const c of bs) map[c.categoryName] = c.score;

      this.setExpr(VRMExpressionPresetName.BlinkLeft, clamp(map.eyeBlinkLeft ?? 0, 0, 1));
      this.setExpr(VRMExpressionPresetName.BlinkRight, clamp(map.eyeBlinkRight ?? 0, 0, 1));

      const mouthOpen = clamp((map.jawOpen ?? 0) * 1.2, 0, 1);
      this.setExpr(VRMExpressionPresetName.Aa, mouthOpen);

      const smile = clamp(((map.mouthSmileLeft ?? 0) + (map.mouthSmileRight ?? 0)) / 2, 0, 1);
      this.setExpr(VRMExpressionPresetName.Happy, smile);
    }
  }

  // Compute rotation that aligns rest direction (down the bone) with the desired direction
  private aimQuat(dir: THREE.Vector3, restDir: THREE.Vector3): THREE.Quaternion {
    const q = new THREE.Quaternion();
    q.setFromUnitVectors(restDir.clone().normalize(), dir.clone().normalize());
    return q;
  }

  private applyPose(pose: PoseLandmarkerResult | null) {
    if (!pose || !pose.landmarks || pose.landmarks.length === 0) return;
    const lm = pose.landmarks[0];
    if (!lm) return;

    // Convert MediaPipe (x:right, y:down, z:depth) to three (x:right, y:up, z:back)
    // Mirror on X for selfie-view feel.
    const v = (i: number) => new THREE.Vector3(-(lm[i].x - 0.5), -(lm[i].y - 0.5), -lm[i].z);

    const lShoulder = v(11);
    const rShoulder = v(12);
    const lElbow = v(13);
    const rElbow = v(14);
    const lWrist = v(15);
    const rWrist = v(16);

    // Upper arms: rest direction in VRM is along -Y (arms hang down)
    const restDown = new THREE.Vector3(0, -1, 0);

    const lUpperDir = lElbow.clone().sub(lShoulder);
    const rUpperDir = rElbow.clone().sub(rShoulder);
    const lLowerDir = lWrist.clone().sub(lElbow);
    const rLowerDir = rWrist.clone().sub(rElbow);

    if (lUpperDir.lengthSq() > 1e-4) {
      this.setBone("leftUpperArm", this.aimQuat(lUpperDir, restDown));
    }
    if (rUpperDir.lengthSq() > 1e-4) {
      this.setBone("rightUpperArm", this.aimQuat(rUpperDir, restDown));
    }
    if (lLowerDir.lengthSq() > 1e-4) {
      // For lower arm we approximate relative to upper arm direction
      const rel = this.aimQuat(lLowerDir, lUpperDir.clone());
      this.setBone("leftLowerArm", rel);
    }
    if (rLowerDir.lengthSq() > 1e-4) {
      const rel = this.aimQuat(rLowerDir, rUpperDir.clone());
      this.setBone("rightLowerArm", rel);
    }

    // Spine: tilt based on shoulders line
    const shoulderDir = rShoulder.clone().sub(lShoulder).normalize();
    const tilt = Math.atan2(shoulderDir.y, shoulderDir.x);
    const spineQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, tilt * 0.5));
    const restSpine = this.restPose["spine"] ?? new THREE.Quaternion();
    this.setBone("spine", restSpine.clone().multiply(spineQ));
  }
}
