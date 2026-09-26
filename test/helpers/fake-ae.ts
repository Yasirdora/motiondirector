/**
 * A fake After Effects for running the real ExtendScript in tests.
 *
 * It models the parts of the scripting DOM Motion Director uses: comps,
 * layers, property groups, keyframes with eases and tangents, expressions,
 * files and folders. The JSX runs in a separate V8 context with ES5+
 * built-ins removed, so code that would not run in After Effects' ES3 engine
 * fails here too. It also enforces After Effects' rule that temporal ease
 * arrays have one entry for spatial properties and one per dimension
 * otherwise.
 *
 * What this cannot prove: that After Effects behaves as modelled. That is
 * checked on a real install (see docs/verification.md).
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { valueAt } from "../../src/lens/evaluate.js";
import type { Keyframe, Vec } from "../../src/lens/types.js";

export const PropertyValueType = {
  NO_VALUE: 6412,
  ThreeD_SPATIAL: 6413,
  ThreeD: 6414,
  TwoD_SPATIAL: 6415,
  TwoD: 6416,
  OneD: 6417,
  COLOR: 6418,
  CUSTOM_VALUE: 6419,
  MARKER: 6420,
  LAYER_INDEX: 6421,
  MASK_INDEX: 6422,
  SHAPE: 6423,
  TEXT_DOCUMENT: 6424,
} as const;
export const PropertyType = { PROPERTY: 6212, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 } as const;
export const KeyframeInterpolationType = { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 } as const;

export class KeyframeEase {
  constructor(
    public speed: number,
    public influence: number,
  ) {}
}

let toContext: <T>(value: T) => T = (v) => v;

function ctxArray<T>(values: T[]): T[] {
  return toContext(values);
}

const interpName = (t: number): Keyframe["inInterpolation"] =>
  t === KeyframeInterpolationType.HOLD ? "hold" : t === KeyframeInterpolationType.BEZIER ? "bezier" : "linear";
const interpCode = (n: Keyframe["inInterpolation"]) =>
  n === "hold" ? KeyframeInterpolationType.HOLD : n === "bezier" ? KeyframeInterpolationType.BEZIER : KeyframeInterpolationType.LINEAR;

export class FakeProperty {
  readonly propertyType = PropertyType.PROPERTY;
  readonly canVaryOverTime = true;
  readonly canSetExpression = true;
  parentProperty: FakeGroup | null = null;
  keys: Keyframe[] = [];
  expression = "";
  expressionEnabled = false;
  expressionError = "";
  /** Stands in for an expression's result, if set. */
  expressionValue: ((t: number) => Vec) | null = null;
  /** Makes the next write fail, to test rollback. */
  failOnAddKey = false;

  constructor(
    public matchName: string,
    public name: string,
    public dimensions: number,
    public isSpatial: boolean,
    public staticValue: Vec,
    public propertyValueType: number = dimensions === 1
      ? PropertyValueType.OneD
      : isSpatial
        ? PropertyValueType.TwoD_SPATIAL
        : PropertyValueType.TwoD,
  ) {}

  get numKeys(): number {
    return this.keys.length;
  }

  private key(i: number): Keyframe {
    const k = this.keys[i - 1];
    if (!k) throw new Error(`After Effects error: key index ${i} out of range`);
    return k;
  }

  private out(value: Vec): number | number[] {
    return this.dimensions === 1 ? (value[0] as number) : ctxArray([...value]);
  }

  keyTime(i: number) { return this.key(i).time; }
  keyValue(i: number) { return this.out(this.key(i).value); }
  keyInInterpolationType(i: number) { return interpCode(this.key(i).inInterpolation); }
  keyOutInterpolationType(i: number) { return interpCode(this.key(i).outInterpolation); }
  keyInTemporalEase(i: number) { return ctxArray(this.key(i).inEase.map((e) => new KeyframeEase(e.speed, e.influence))); }
  keyOutTemporalEase(i: number) { return ctxArray(this.key(i).outEase.map((e) => new KeyframeEase(e.speed, e.influence))); }
  keyTemporalContinuous(i: number) { return this.key(i).temporalContinuous; }
  keyTemporalAutoBezier(i: number) { return this.key(i).temporalAutoBezier; }
  keyInSpatialTangent(i: number) { return ctxArray([...(this.key(i).inTangent ?? [0, 0])]); }
  keyOutSpatialTangent(i: number) { return ctxArray([...(this.key(i).outTangent ?? [0, 0])]); }
  keySpatialContinuous(i: number) { return this.key(i).spatialContinuous ?? false; }
  keySpatialAutoBezier(i: number) { return this.key(i).spatialAutoBezier ?? false; }
  keyRoving(i: number) { return this.key(i).roving ?? false; }

  valueAtTime(t: number, _preExpression: boolean) {
    if (this.expressionEnabled && this.expressionValue) return this.out(this.expressionValue(t));
    if (this.keys.length === 0) return this.out(this.staticValue);
    return this.out(valueAt({ keys: this.keys, spatial: this.isSpatial, dimensions: this.dimensions }, t));
  }

  removeKey(i: number) {
    this.key(i);
    this.keys.splice(i - 1, 1);
  }

  addKey(t: number): number {
    if (this.failOnAddKey) {
      this.failOnAddKey = false;
      throw new Error("After Effects error: simulated failure while adding a key");
    }
    const existing = this.keys.findIndex((k) => Math.abs(k.time - t) < 1e-9);
    if (existing >= 0) return existing + 1;
    const ease = () => Array.from({ length: this.isSpatial ? 1 : this.dimensions }, () => ({ speed: 0, influence: 16.666666667 }));
    const key: Keyframe = {
      time: t,
      value: [...this.staticValue],
      inInterpolation: "linear",
      outInterpolation: "linear",
      inEase: ease(),
      outEase: ease(),
      temporalContinuous: false,
      temporalAutoBezier: false,
      ...(this.isSpatial ? { inTangent: [0, 0], outTangent: [0, 0], spatialContinuous: false, spatialAutoBezier: false, roving: false } : {}),
    };
    this.keys.push(key);
    this.keys.sort((a, b) => a.time - b.time);
    return this.keys.indexOf(key) + 1;
  }

  setValueAtKey(i: number, value: number | number[]) {
    const vec = typeof value === "number" ? [value] : Array.from(value);
    if (vec.length !== this.dimensions) throw new Error(`After Effects error: value has ${vec.length} dimensions, expected ${this.dimensions}`);
    this.key(i).value = vec;
  }

  setInterpolationTypeAtKey(i: number, inType: number, outType: number) {
    this.key(i).inInterpolation = interpName(inType);
    this.key(i).outInterpolation = interpName(outType);
  }

  setTemporalEaseAtKey(i: number, inEase: KeyframeEase[], outEase: KeyframeEase[]) {
    const arity = this.isSpatial ? 1 : this.dimensions;
    if (inEase.length !== arity || outEase.length !== arity) {
      throw new Error(`After Effects error: temporal ease arrays must have ${arity} element(s)`);
    }
    this.key(i).inEase = Array.from(inEase, (e) => ({ speed: e.speed, influence: e.influence }));
    this.key(i).outEase = Array.from(outEase, (e) => ({ speed: e.speed, influence: e.influence }));
  }

  setTemporalContinuousAtKey(i: number, v: boolean) { this.key(i).temporalContinuous = v; }
  setTemporalAutoBezierAtKey(i: number, v: boolean) { this.key(i).temporalAutoBezier = v; }
  setSpatialTangentsAtKey(i: number, inT: number[], outT: number[]) {
    this.key(i).inTangent = Array.from(inT);
    this.key(i).outTangent = Array.from(outT);
  }
  setSpatialContinuousAtKey(i: number, v: boolean) { this.key(i).spatialContinuous = v; }
  setSpatialAutoBezierAtKey(i: number, v: boolean) { this.key(i).spatialAutoBezier = v; }
  setRovingAtKey(i: number, v: boolean) {
    if (i === 1 || i === this.keys.length) throw new Error("After Effects error: the first and last keys cannot rove");
    this.key(i).roving = v;
  }
}

export class FakeGroup {
  propertyType: number = PropertyType.NAMED_GROUP;
  parentProperty: FakeGroup | null = null;
  readonly children: (FakeGroup | FakeProperty)[] = [];

  constructor(
    public matchName: string,
    public name: string,
  ) {}

  add<T extends FakeGroup | FakeProperty>(child: T): T {
    child.parentProperty = this;
    this.children.push(child);
    return child;
  }

  get numProperties(): number {
    return this.children.length;
  }

  property(which: number | string): FakeGroup | FakeProperty | null {
    if (typeof which === "number") return this.children[which - 1] ?? null;
    return this.children.find((c) => c.matchName === which || c.name === which) ?? null;
  }
}

export class FakeLayer extends FakeGroup {
  comp: CompItem | null = null;
  parent: FakeLayer | null = null;
  enabled = true;
  readonly transform: FakeGroup;

  constructor(
    public id: number,
    name: string,
    public inPoint = 0,
    public outPoint = 10,
    matchName = "ADBE Vector Layer",
  ) {
    super(matchName, name);
    this.transform = this.add(new FakeGroup("ADBE Transform Group", "Transform"));
    this.transform.add(new FakeProperty("ADBE Anchor Point", "Anchor Point", 2, true, [0, 0], PropertyValueType.TwoD_SPATIAL));
    this.transform.add(new FakeProperty("ADBE Position", "Position", 2, true, [960, 540]));
    this.transform.add(new FakeProperty("ADBE Scale", "Scale", 2, false, [100, 100]));
    this.transform.add(new FakeProperty("ADBE Rotate Z", "Rotation", 1, false, [0]));
    this.transform.add(new FakeProperty("ADBE Opacity", "Opacity", 1, false, [100]));
  }

  get index(): number {
    return (this.comp?.layers.indexOf(this) ?? -1) + 1;
  }

  prop(matchName: string): FakeProperty {
    const p = this.transform.property(matchName);
    if (!(p instanceof FakeProperty)) throw new Error(`no ${matchName}`);
    return p;
  }
}

export class FolderItem {
  constructor(
    public id: number,
    public name: string,
  ) {}
}

export class CompItem {
  layers: FakeLayer[] = [];
  comment = "";
  parentFolder: FolderItem | null = null;
  resolutionFactor: number[] = [1, 1];
  workAreaStart = 0;
  removed = false;

  constructor(
    public project: FakeProject,
    public id: number,
    public name: string,
    public width = 1920,
    public height = 1080,
    public frameRate = 30,
    public duration = 3,
    public workAreaDuration = duration,
  ) {}

  get numLayers(): number {
    return this.layers.length;
  }

  layer(i: number): FakeLayer {
    const l = this.layers[i - 1];
    if (!l) throw new Error(`After Effects error: layer ${i} out of range`);
    return l;
  }

  addLayer(layer: FakeLayer): FakeLayer {
    layer.comp = this;
    this.layers.push(layer);
    return layer;
  }

  duplicate(): CompItem {
    const copy = this.project.addComp(`${this.name} 2`, this.width, this.height, this.frameRate, this.duration);
    copy.workAreaStart = this.workAreaStart;
    copy.workAreaDuration = this.workAreaDuration;
    for (const layer of this.layers) {
      const clone = copy.addLayer(new FakeLayer(this.project.nextId(), layer.name, layer.inPoint, layer.outPoint, layer.matchName));
      clone.enabled = layer.enabled;
      for (const child of layer.transform.children) {
        if (!(child instanceof FakeProperty)) continue;
        const target = clone.prop(child.matchName);
        target.keys = structuredClone(child.keys);
        target.staticValue = [...child.staticValue];
        target.expression = child.expression;
        target.expressionEnabled = child.expressionEnabled;
        target.expressionValue = child.expressionValue;
      }
    }
    return copy;
  }

  remove(): void {
    this.removed = true;
    this.project.items = this.project.items.filter((i) => i !== this);
  }

  saveFrameToPng(time: number, file: FakeFile): void {
    // A 1×1 PNG is enough to exercise the path; the server checks sizes itself.
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
        "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
      "hex",
    );
    writeFileSync(file.fsName, png);
    this.project.frames.push({ compId: this.id, time, factor: [...this.resolutionFactor] });
  }
}

export class FakeProject {
  items: (CompItem | FolderItem)[] = [];
  file: FakeFile | null = null;
  activeItem: CompItem | null = null;
  frames: { compId: number; time: number; factor: number[] }[] = [];
  private seq = 1;

  nextId(): number {
    return this.seq++;
  }

  addComp(name: string, width = 1920, height = 1080, frameRate = 30, duration = 3): CompItem {
    const comp = new CompItem(this, this.nextId(), name, width, height, frameRate, duration);
    this.items.push(comp);
    return comp;
  }

  get numItems(): number {
    return this.items.length;
  }

  item(i: number) {
    return this.items[i - 1];
  }

  itemByID(id: number) {
    return this.items.find((i) => i.id === id) ?? null;
  }

  readonly itemsApi = {
    addFolder: (name: string) => {
      const folder = new FolderItem(this.nextId(), name);
      this.items.push(folder);
      return folder;
    },
  };
}

export class FakeFile {
  encoding = "UTF-8";
  private mode: string | null = null;
  private buffer = "";

  constructor(public fsName: string) {}

  get name(): string {
    return encodeURI(path.basename(this.fsName));
  }
  get displayName(): string {
    return path.basename(this.fsName);
  }
  get parent(): FakeFolder {
    return new FakeFolder(path.dirname(this.fsName));
  }
  get exists(): boolean {
    return existsSync(this.fsName);
  }
  get modified(): Date {
    return statSync(this.fsName).mtime;
  }
  open(mode: string): boolean {
    if (mode === "r" && !this.exists) return false;
    this.mode = mode;
    this.buffer = mode === "a" && this.exists ? readFileSync(this.fsName, "utf8") : "";
    return true;
  }
  read(): string {
    return readFileSync(this.fsName, "utf8");
  }
  write(text: string): void {
    this.buffer += text;
  }
  writeln(text: string): void {
    this.buffer += `${text}\n`;
  }
  close(): void {
    if (this.mode === "w" || this.mode === "a") writeFileSync(this.fsName, this.buffer);
    this.mode = null;
  }
  remove(): boolean {
    try {
      unlinkSync(this.fsName);
      return true;
    } catch {
      return false;
    }
  }
  rename(newName: string): boolean {
    const target = path.join(path.dirname(this.fsName), newName);
    renameSync(this.fsName, target);
    this.fsName = target;
    return true;
  }
}

export class FakeFolder {
  static temp: FakeFolder;

  constructor(public fsName: string) {}

  get exists(): boolean {
    return existsSync(this.fsName);
  }

  getFiles(mask: string): FakeFile[] {
    const pattern = new RegExp(`^${mask.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    return ctxArray(
      readdirSync(this.fsName)
        .filter((n) => pattern.test(n))
        .map((n) => new FakeFile(path.join(this.fsName, n))),
    );
  }
}

export interface FakeAfterEffects {
  project: FakeProject;
  undoGroups: string[];
  suppressedDialogs: number;
  /** Runs dispatcher.jsx once, as one DoScript launch would. */
  runDispatcher(mailbox: string): void;
}

const JSX_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "jsx");

/** Removes ES5+ built-ins from a context so JSX that relies on them fails like it would in After Effects. */
const ES3_PRELUDE = `
  delete Array.prototype.forEach; delete Array.prototype.map; delete Array.prototype.filter;
  delete Array.prototype.indexOf; delete Array.prototype.reduce; delete Array.prototype.some;
  delete Array.prototype.every; delete Array.isArray; delete Object.keys; delete Object.create;
  delete String.prototype.trim; delete Date.prototype.toISOString; delete Date.now;
  delete Function.prototype.bind; delete this.JSON;
`;

export function createFakeAfterEffects(tempRoot: string): FakeAfterEffects {
  const project = new FakeProject();
  const state: FakeAfterEffects = {
    project,
    undoGroups: [],
    suppressedDialogs: 0,
    runDispatcher(mailbox: string) {
      const context: Record<string, unknown> = {};
      const $ = {
        fileName: path.join(JSX_DIR, "dispatcher.jsx"),
        global: context,
        evalFile(file: FakeFile) {
          const previous = $.fileName;
          $.fileName = file.fsName;
          try {
            vm.runInContext(readFileSync(file.fsName, "utf8"), sandbox, { filename: file.fsName });
          } finally {
            $.fileName = previous;
          }
        },
      };
      let openGroups = 0;
      const app = {
        version: "26.0 (fake)",
        project: new Proxy(project, {
          get(target, key) {
            // Scripts see project.items as the "add folder" API, while the
            // project's own methods keep working on the real item list.
            if (key === "items") return target.itemsApi;
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
        beginUndoGroup(name: string) {
          openGroups++;
          state.undoGroups.push(name);
        },
        endUndoGroup() {
          if (openGroups === 0) throw new Error("After Effects error: undo group mismatch");
          openGroups--;
        },
        beginSuppressDialogs() {
          state.suppressedDialogs++;
        },
        endSuppressDialogs(_alert: boolean) {},
      };
      Object.assign(context, {
        $,
        app,
        File: FakeFile,
        Folder: FakeFolder,
        CompItem,
        FolderItem,
        KeyframeEase,
        PropertyValueType,
        PropertyType,
        KeyframeInterpolationType,
      });
      // As the macOS bootstrap does: the launcher names the exact mailbox.
      context.MOTION_DIRECTOR_MAILBOX = mailbox;
      FakeFolder.temp = new FakeFolder(tempRoot);
      const sandbox = vm.createContext(context);
      vm.runInContext(ES3_PRELUDE, sandbox);
      const copyIn = vm.runInContext(
        "(function copyIn(v){ if (v === null || typeof v !== 'object' || !(v.length >= 0) || typeof v === 'string') return v; var r = []; for (var i = 0; i < v.length; i++) r.push(v[i]); return r; })",
        sandbox,
      ) as <T>(v: T) => T;
      toContext = copyIn;
      try {
        vm.runInContext(readFileSync(path.join(JSX_DIR, "dispatcher.jsx"), "utf8"), sandbox, { filename: "dispatcher.jsx" });
      } finally {
        toContext = (v) => v;
      }
      if (openGroups !== 0) throw new Error("the dispatcher left an undo group open");
    },
  };
  mkdirSync(tempRoot, { recursive: true });
  return state;
}
