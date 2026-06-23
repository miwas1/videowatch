import { PRESETS, type WorkflowPreset } from "@/lib/presets";

type Props = {
  selected: string;
  onChange: (id: string) => void;
};

export function PresetRail({ selected, onChange }: Props) {
  return (
    <div className="preset-rail" role="radiogroup" aria-label="Workflow preset">
      {PRESETS.map((preset: WorkflowPreset) => (
        <button
          key={preset.id}
          role="radio"
          aria-checked={selected === preset.id}
          className={`preset-chip${selected === preset.id ? " preset-chip--active" : ""}`}
          onClick={() => onChange(preset.id)}
          type="button"
        >
          <span className="preset-chip__label">{preset.label}</span>
          <span className="preset-chip__tagline">{preset.tagline}</span>
        </button>
      ))}
    </div>
  );
}
