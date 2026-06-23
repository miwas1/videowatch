import { Fragment, type ReactNode } from "react";
import { formatTimestamp } from "@/lib/format";
import type { Artifact } from "@/api/types";

type Props = { artifact: Artifact };

export function ArtifactDocument({ artifact }: Props) {
  const sections = artifact.payload.sections ?? [];
  if (sections.length === 0) {
    return <div className="artifact-document artifact-document--markdown">{renderMarkdown(artifact.markdown)}</div>;
  }

  return (
    <article className={`artifact-document artifact-document--${artifact.workflow_template}`}>
      {sections.map((section, index) => (
        <section className={`artifact-section artifact-section--${section.kind}`} key={`${section.heading}-${index}`}>
          <div className="artifact-section__meta">
            <span>{section.kind.replaceAll("_", " ")}</span>
            <span>{formatTimestamp(section.start_seconds)}–{formatTimestamp(section.end_seconds)}</span>
          </div>
          <h2>{section.heading}</h2>
          {section.kind === "code" ? <pre><code>{section.body}</code></pre> : <p>{section.body}</p>}
        </section>
      ))}
    </article>
  );
}

function renderMarkdown(markdown: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const lines = markdown.split("\n");
  let code: string[] | null = null;
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("```")) {
      if (code) {
        nodes.push(<pre key={`code-${index}`}><code>{code.join("\n")}</code></pre>);
        code = null;
      } else {
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (line.startsWith("### ")) nodes.push(<h3 key={index}>{line.slice(4)}</h3>);
    else if (line.startsWith("## ")) nodes.push(<h2 key={index}>{line.slice(3)}</h2>);
    else if (line.startsWith("# ")) nodes.push(<h1 key={index}>{line.slice(2)}</h1>);
    else if (line.startsWith("- ")) nodes.push(<p className="artifact-document__list-item" key={index}>• {line.slice(2)}</p>);
    else if (line.startsWith("> ")) nodes.push(<blockquote key={index}>{line.slice(2)}</blockquote>);
    else if (line.trim()) nodes.push(<p key={index}>{line}</p>);
    else nodes.push(<Fragment key={index}><br /></Fragment>);
  }
  if (code) nodes.push(<pre key="code-final"><code>{code.join("\n")}</code></pre>);
  return nodes;
}
