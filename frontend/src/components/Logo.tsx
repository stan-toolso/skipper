/**
 * Pictogramme Skipper : une rose des vents à huit pointes (héritière de l'astérisque ✻ de
 * Claude Code), la pointe nord en couleur d'accent. Les pointes reprennent `currentColor`,
 * ce qui permet de le poser sur n'importe quel fond. Les fichiers SVG équivalents sont dans
 * `frontend/public/` (favicon.svg, logo-mark*.svg).
 */
export default function Logo({ size = 18, accent = 'var(--cc-accent)', mono = false, className }: { size?: number; accent?: string; mono?: boolean; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className} style={{ flex: '0 0 auto' }}>
      <path d="M16.95 7.05L13.6 12L16.95 16.95L12 13.6L7.05 16.95L10.4 12L7.05 7.05L12 10.4Z" fill="currentColor" opacity="0.45" />
      <path d="M12 1L13.8 10.2L23 12L13.8 13.8L12 23L10.2 13.8L1 12L10.2 10.2Z" fill="currentColor" />
      {!mono && <path d="M12 1L13.8 10.2L10.2 10.2Z" fill={accent} />}
    </svg>
  );
}
