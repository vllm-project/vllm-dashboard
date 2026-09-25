/**
 * The vLLM logomark, traced from the official
 * `docs/assets/logos/vllm-logo-only-light.png` in vllm-project/vllm.
 *
 * Rendered as inline SVG so it stays crisp at any size and its drop shadow
 * follows `currentColor`, which keeps it looking right in both themes.
 */
export function VllmMark({
  className,
  title,
  shadow = true,
}: {
  className?: string;
  /** Accessible name. Omit when the mark is decorative. */
  title?: string;
  shadow?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 880 905"
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      xmlns="http://www.w3.org/2000/svg"
    >
      {title ? <title>{title}</title> : null}
      {shadow ? (
        <g fill="currentColor" opacity="0.14" transform="translate(16 16)">
          <path d="M8 196H353V885Z" />
          <path d="M536 180L857 8L625 885H354Z" />
        </g>
      ) : null}
      <path d="M8 196H353V885Z" fill="#EBB431" />
      <path d="M536 180L857 8L625 885H354Z" fill="#63A1FC" />
    </svg>
  );
}
