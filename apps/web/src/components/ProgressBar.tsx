type Props = { percent: number; className?: string };

export function ProgressBar({ percent, className = "" }: Props) {
  return (
    <div className={`progress-track ${className}`} role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}
