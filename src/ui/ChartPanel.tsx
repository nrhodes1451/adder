import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChartLayer, EditTarget } from "../charts/ChartLayer";
import { resetPart } from "../charts/parts";
import {
  type AxisFormat,
  CHART_TYPES,
  type ChartPart,
  type ChartStyle,
  type ChartType,
  DEFAULT_MARKER,
  type FontKey,
  isHollow,
  MARKER_SHAPES,
  type MarkerFormat,
  type MarkerShape,
  type SeriesFormat,
  seriesColor,
  type TextFormat,
} from "../charts/model";

interface Props {
  layer: ChartLayer;
  target: EditTarget;
  onClose: () => void;
}

const SECTIONS: [ChartPart, string][] = [
  ["area", "Chart Area"],
  ["title", "Title"],
  ["legend", "Legend"],
  ["series", "Series"],
  ["xAxis", "Horizontal Axis"],
  ["yAxis", "Vertical Axis"],
];

/** Drop unset keys so a cleared field falls back to the theme. */
function clean<T extends object>(o: T): T | undefined {
  const out = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "")) as T;
  return Object.keys(out).length ? out : undefined;
}

const numberOrUndefined = (s: string) => (s.trim() === "" || Number.isNaN(Number(s)) ? undefined : Number(s));
const capitalise = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** Side panel formatting one chart; opened from a chart's context menu. */
export function ChartPanel({ layer, target, onClose }: Props) {
  const spec = useSyncExternalStore(layer.subscribe, () => layer.get(target.id));
  const [open, setOpen] = useState<Set<ChartPart>>(() => new Set([target.part]));
  const [seriesIndex, setSeriesIndex] = useState(target.series ?? 0);
  const sections = useRef(new Map<ChartPart, HTMLDetailsElement>());

  // Another right-click while open: show that part.
  useEffect(() => {
    setOpen((o) => new Set(o).add(target.part));
    if (target.series !== undefined) setSeriesIndex(target.series);
    requestAnimationFrame(() => sections.current.get(target.part)?.scrollIntoView({ block: "nearest" }));
  }, [target]);

  useEffect(() => {
    layer.setEditing(spec ? target.id : null);
    return () => layer.setEditing(null);
  }, [layer, target.id, spec]);

  useEffect(() => {
    if (!spec) onClose(); // deleted
  }, [spec, onClose]);
  if (!spec) return null;

  const data = layer.data(spec.id);
  const palette = layer.palette;
  const style = spec.style ?? {};
  const pie = spec.type === "pie";
  const series = data?.series ?? [];
  const si = Math.min(seriesIndex, Math.max(0, series.length - 1));

  const set = <K extends Exclude<keyof ChartStyle, "series">>(k: K, patch: Partial<NonNullable<ChartStyle[K]>>) =>
    layer.setStyle(spec.id, (s) => ({ ...s, [k]: clean({ ...s[k], ...patch }) }));
  const setSeries = (patch: Partial<SeriesFormat>) =>
    layer.setStyle(spec.id, (s) => ({ ...s, series: clean({ ...s.series, [si]: clean({ ...s.series?.[si], ...patch }) }) }));
  const fmt: SeriesFormat = style.series?.[si] ?? {};

  const body: Record<ChartPart, ReactNode> = {
    area: (
      <>
        <Field label="Chart type">
          <select value={spec.type} onChange={(e) => layer.setType(spec.id, e.target.value as ChartType)}>
            {CHART_TYPES.map((t) => (
              <option key={t} value={t}>
                {capitalise(t)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Background">
          <Colour value={style.area?.background} fallback={palette.bg} onChange={(background) => set("area", { background })} />
        </Field>
        <Field label="Font">
          <FontSelect value={style.area?.font} onChange={(font) => set("area", { font })} defaultLabel="Sans" />
        </Field>
        <div className="buttons">
          {(style.plot || style.title?.pos || style.legend?.pos) && (
            <button onClick={() => layer.setStyle(spec.id, (s) => resetPart(resetPart(resetPart(s, "plot"), "title"), "legend"))}>Reset layout</button>
          )}
          <button className="danger" onClick={() => layer.remove(spec.id)}>
            Delete chart
          </button>
        </div>
      </>
    ),
    title: (
      <>
        <Check label="Show title" checked={style.title?.show ?? true} onChange={(show) => set("title", { show: show ? undefined : false })} />
        <Field label="Text">
          <input type="text" value={style.title?.text ?? ""} placeholder={data?.title ?? "Chart title"} onChange={(e) => set("title", { text: e.target.value })} />
        </Field>
        <Field label="Align">
          <select value={style.title?.align ?? "center"} onChange={(e) => set("title", { align: e.target.value === "center" ? undefined : (e.target.value as "left" | "right"), pos: undefined })}>
            <option value="left">Left</option>
            <option value="center">Centre</option>
            <option value="right">Right</option>
          </select>
        </Field>
        <TextControls f={style.title} size={14} bold fallback={palette.text} onChange={(p) => set("title", p)} />
      </>
    ),
    legend: (
      <>
        <Check label="Show legend" checked={style.legend?.show ?? (series.length > 1 || pie)} onChange={(show) => set("legend", { show })} />
        <Field label="Position">
          <select value={style.legend?.position ?? "bottom"} onChange={(e) => set("legend", { position: e.target.value === "bottom" ? undefined : (e.target.value as "top"), pos: undefined })}>
            {["top", "bottom", "left", "right"].map((p) => (
              <option key={p} value={p}>
                {capitalise(p)}
              </option>
            ))}
          </select>
        </Field>
        <TextControls f={style.legend} size={12} fallback={palette.text} onChange={(p) => set("legend", p)} />
      </>
    ),
    series: (
      <>
        {series.length > 1 && (
          <Field label="Series">
            <select aria-label="Series to edit" value={si} onChange={(e) => setSeriesIndex(Number(e.target.value))}>
              {series.map((s, i) => (
                <option key={i} value={i}>
                  {style.series?.[i]?.name || s.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Name">
          <input type="text" aria-label="Series name" value={fmt.name ?? ""} placeholder={series[si]?.name} onChange={(e) => setSeries({ name: e.target.value })} />
        </Field>
        {pie ? (
          (data?.categories ?? []).map((c, i) => (
            <Field key={i} label={c || `Slice ${i + 1}`}>
              <Colour value={fmt.points?.[i]} fallback={seriesColor(palette, i)} onChange={(v) => setSeries({ points: clean({ ...fmt.points, [i]: v }) })} />
            </Field>
          ))
        ) : (
          <Field label="Colour">
            <Colour value={fmt.color} fallback={seriesColor(palette, si)} onChange={(color) => setSeries({ color })} />
          </Field>
        )}
        <Check label="Data labels" checked={fmt.labels ?? pie} onChange={(labels) => setSeries({ labels: labels === pie ? undefined : labels })} />
        {spec.type === "line" && (
          <>
            <Field label="Line width">
              <NumberInput value={fmt.width} placeholder="2" min={1} max={12} onChange={(width) => setSeries({ width })} />
            </Field>
            <Check label="Smooth line" checked={fmt.smooth ?? false} onChange={(smooth) => setSeries({ smooth: smooth || undefined })} />
            <div className="subhead">Markers</div>
            <Check
              label="Show markers"
              checked={fmt.markers ?? (series[si]?.data.length ?? 0) <= 50}
              onChange={(markers) => setSeries({ markers })}
            />
            {(fmt.markers ?? (series[si]?.data.length ?? 0) <= 50) && (
              <MarkerControls type="line" f={fmt} colour={fmt.color ?? seriesColor(palette, si)} onChange={(marker) => setSeries({ marker })} />
            )}
          </>
        )}
        {spec.type === "scatter" && (
          <>
            <div className="subhead">Markers</div>
            {/* Size moves from the legacy `width` to `marker.size`. */}
            <MarkerControls type="scatter" f={fmt} colour={fmt.color ?? seriesColor(palette, si)} onChange={(marker) => setSeries({ marker, width: undefined })} />
          </>
        )}
      </>
    ),
    xAxis: <AxisControls f={style.xAxis} value={spec.type === "scatter"} gridLines={spec.type === "scatter"} fallback={palette.headerText} onChange={(p) => set("xAxis", p)} />,
    yAxis: <AxisControls f={style.yAxis} value gridLines fallback={palette.headerText} onChange={(p) => set("yAxis", p)} />,
  };

  return (
    <aside className="chart-panel" aria-label="Format chart" data-testid="chart-panel" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="chart-panel-head">
        <strong>Format Chart</strong>
        <button className="link" aria-label="Close" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="chart-panel-body">
        {SECTIONS.filter(([part]) => !(pie && (part === "xAxis" || part === "yAxis"))).map(([part, label]) => (
          <details
            key={part}
            ref={(el) => {
              if (el) sections.current.set(part, el);
            }}
            open={open.has(part)}
            onToggle={(e) => {
              const isOpen = e.currentTarget.open;
              setOpen((o) => {
                if (o.has(part) === isOpen) return o;
                const n = new Set(o);
                if (isOpen) n.add(part);
                else n.delete(part);
                return n;
              });
            }}
          >
            <summary>{label}</summary>
            <div className="chart-panel-section">{body[part]}</div>
          </details>
        ))}
      </div>
    </aside>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="field check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** A colour that follows the theme until set; Reset clears the override. */
function Colour({ value, fallback, onChange }: { value?: string; fallback: string; onChange: (v: string | undefined) => void }) {
  return (
    <span className="colour">
      <input type="color" value={toHex(value ?? fallback)} onChange={(e) => onChange(e.target.value)} />
      {value && (
        <button type="button" className="link" onClick={() => onChange(undefined)}>
          Reset
        </button>
      )}
    </span>
  );
}

function NumberInput(props: { value?: number; placeholder: string; min?: number; max?: number; onChange: (v: number | undefined) => void }) {
  return (
    <input
      type="number"
      value={props.value ?? ""}
      placeholder={props.placeholder}
      min={props.min}
      max={props.max}
      onChange={(e) => props.onChange(numberOrUndefined(e.target.value))}
    />
  );
}

function FontSelect({ value, onChange, defaultLabel = "Default" }: { value?: FontKey; onChange: (v: FontKey | undefined) => void; defaultLabel?: string }) {
  return (
    <select value={value ?? ""} onChange={(e) => onChange((e.target.value || undefined) as FontKey | undefined)}>
      <option value="">{defaultLabel}</option>
      <option value="serif">Serif</option>
      <option value="mono">Monospace</option>
      {defaultLabel !== "Sans" && <option value="sans">Sans</option>}
    </select>
  );
}

function TextControls({ f, size, bold = false, fallback, onChange }: { f?: TextFormat; size: number; bold?: boolean; fallback: string; onChange: (p: Partial<TextFormat>) => void }) {
  return (
    <>
      <Field label="Font">
        <FontSelect value={f?.font} onChange={(font) => onChange({ font })} />
      </Field>
      <Field label="Size">
        <NumberInput value={f?.size} placeholder={String(size)} min={6} max={48} onChange={(s) => onChange({ size: s })} />
      </Field>
      <div className="field">
        <span>Style</span>
        <span className="toggles">
          <button type="button" aria-pressed={f?.bold ?? bold} className={(f?.bold ?? bold) ? "active" : ""} onClick={() => onChange({ bold: (f?.bold ?? bold) === bold ? !bold : undefined })}>
            <b>B</b>
          </button>
          <button type="button" aria-pressed={!!f?.italic} className={f?.italic ? "active" : ""} onClick={() => onChange({ italic: f?.italic ? undefined : true })}>
            <i>I</i>
          </button>
        </span>
      </div>
      <Field label="Colour">
        <Colour value={f?.color} fallback={fallback} onChange={(color) => onChange({ color })} />
      </Field>
    </>
  );
}

const SHAPE_NAMES: Record<MarkerShape, string> = {
  emptyCircle: "Hollow circle",
  circle: "Circle",
  emptyRect: "Hollow square",
  rect: "Square",
  emptyTriangle: "Hollow triangle",
  triangle: "Triangle",
  emptyDiamond: "Hollow diamond",
  diamond: "Diamond",
};

/** Marker shape, size and colours for a line or scatter series. Reports the whole new marker format. */
function MarkerControls({ type, f, colour, onChange }: { type: "line" | "scatter"; f: SeriesFormat; colour: string; onChange: (m: MarkerFormat | undefined) => void }) {
  const mk = f.marker ?? {};
  const def = DEFAULT_MARKER[type];
  const shape = mk.shape ?? def.shape;
  const set = (p: Partial<MarkerFormat>) => onChange(clean({ ...mk, size: mk.size ?? (type === "scatter" ? f.width : undefined), ...p }));
  return (
    <>
      <Field label="Shape">
        <select aria-label="Marker shape" value={shape} onChange={(e) => set({ shape: e.target.value === def.shape ? undefined : (e.target.value as MarkerShape) })}>
          {MARKER_SHAPES.map((s) => (
            <option key={s} value={s}>
              {SHAPE_NAMES[s]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Size">
        <NumberInput value={mk.size ?? (type === "scatter" ? f.width : undefined)} placeholder={String(def.size)} min={2} max={40} onChange={(size) => set({ size })} />
      </Field>
      {isHollow(shape) ? (
        <Field label="Colour">
          <Colour value={mk.border} fallback={colour} onChange={(border) => set({ border })} />
        </Field>
      ) : (
        <>
          <Field label="Fill">
            <Colour value={mk.fill} fallback={colour} onChange={(fill) => set({ fill })} />
          </Field>
          <Field label="Border">
            <Colour value={mk.border} fallback={colour} onChange={(border) => set({ border })} />
          </Field>
          <Field label="Border width">
            <NumberInput value={mk.borderWidth} placeholder={mk.border ? "1" : "0"} min={0} max={8} onChange={(borderWidth) => set({ borderWidth })} />
          </Field>
        </>
      )}
    </>
  );
}

function AxisControls({ f, value, gridLines, fallback, onChange }: { f?: AxisFormat; value: boolean; gridLines: boolean; fallback: string; onChange: (p: Partial<AxisFormat>) => void }) {
  return (
    <>
      <Field label="Axis title">
        <input type="text" value={f?.title ?? ""} placeholder="None" onChange={(e) => onChange({ title: e.target.value })} />
      </Field>
      <Check label="Gridlines" checked={f?.gridLines ?? gridLines} onChange={(v) => onChange({ gridLines: v === gridLines ? undefined : v })} />
      {value && (
        <>
          <Field label="Minimum">
            <NumberInput value={f?.min} placeholder="Auto" onChange={(min) => onChange({ min })} />
          </Field>
          <Field label="Maximum">
            <NumberInput value={f?.max} placeholder="Auto" onChange={(max) => onChange({ max })} />
          </Field>
        </>
      )}
      <TextControls f={f} size={12} fallback={fallback} onChange={onChange} />
    </>
  );
}

/** `<input type="color">` only takes #rrggbb. */
function toHex(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  if (/^#[0-9a-f]{3}$/i.test(c)) return "#" + [...c.slice(1)].map((h) => h + h).join("");
  const m = c.match(/\d+/g);
  return m && m.length >= 3 ? "#" + m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("") : "#000000";
}
