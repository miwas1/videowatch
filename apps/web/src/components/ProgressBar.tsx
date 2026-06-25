type Props = { percent: number; className?: string };

export function ProgressBar({ percent, className = "" }: Props) {
  return (
    <div className={`progress-track${percent >= 100 ? " progress-track--complete" : ""} ${className}`} role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={`Processing progress: ${percent}%`}>
      <div className="progress-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}
