import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ArtifactDocument } from "@/components/ArtifactDocument";
import { PresetRail } from "@/components/PresetRail";
import { PRESETS } from "./presets";

describe("workflow templates", () => {
  it("defines exactly ten complete and unique workflow modes", () => {
    expect(PRESETS).toHaveLength(10);
    expect(new Set(PRESETS.map((preset) => preset.id)).size).toBe(10);
    for (const preset of PRESETS) {
      expect(preset.label).toBeTruthy();
      expect(preset.outputLabel).toBeTruthy();
      expect(preset.blockEmphasis.length).toBeGreaterThan(0);
      expect(preset.exportDefault).toBeTruthy();
    }
  });

  it("renders every template in the accessible preset selector", () => {
    render(<PresetRail selected="reading_document" onChange={() => undefined} />);
    expect(screen.getAllByRole("radio")).toHaveLength(10);
    for (const preset of PRESETS) expect(screen.getByRole("radio", { name: new RegExp(preset.label) })).toBeTruthy();
  });

  it.each(PRESETS)("renders structured $label artifact sections", (preset) => {
    render(
      <ArtifactDocument
        artifact={{
          id: `artifact-${preset.id}`,
          artifact_type: preset.id,
          workflow_template: preset.id,
          title: preset.label,
          summary: `Summary for ${preset.label}`,
          markdown: "",
          payload: {
            sections: [{
              heading: `${preset.outputLabel} section`,
              body: `Specific output for ${preset.id}`,
              start_seconds: 0,
              end_seconds: 30,
              kind: preset.blockEmphasis[0],
            }],
          },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: `${preset.outputLabel} section` })).toBeTruthy();
    expect(screen.getByText(`Specific output for ${preset.id}`)).toBeTruthy();
  });
});
