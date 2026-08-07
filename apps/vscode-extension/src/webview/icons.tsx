import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function IconBase({ children, ...props }: IconProps) {
  return (
    <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 16 16" width="16" {...props}>
      {children}
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M8 3.25v9.5M3.25 8h9.5" stroke="currentColor" strokeLinecap="round" />
    </IconBase>
  );
}

export function HistoryIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M3.25 5.5A5.25 5.25 0 1 1 2.9 9M3.25 2.75V5.5H6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8 5v3.2l2.15 1.25" stroke="currentColor" strokeLinecap="round" />
    </IconBase>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect height="8.5" rx="1" stroke="currentColor" width="8.5" x="5" y="4.5" />
      <path
        d="M11 4.25V3.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1V10a1 1 0 0 0 1 1h.75"
        stroke="currentColor"
      />
    </IconBase>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M12.4 5.3A5 5 0 1 0 12.75 10M12.4 2.75V5.3H9.85"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

export function SendIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="m2.5 2.75 11 5.25-11 5.25 1.2-4.1L9 8 3.7 6.85l-1.2-4.1Z"
        stroke="currentColor"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect fill="currentColor" height="7" rx="1" width="7" x="4.5" y="4.5" />
    </IconBase>
  );
}

export function CodeIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="m5.5 3.75-4 4.25 4 4.25M10.5 3.75l4 4.25-4 4.25M9 2.75 7 13.25"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

export function FileIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 1.75h5l3 3v9.5H4V1.75Z" stroke="currentColor" strokeLinejoin="round" />
      <path d="M9 1.75v3h3" stroke="currentColor" strokeLinejoin="round" />
    </IconBase>
  );
}

export function FilesIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M5.25 3.25V1.75h4.5l2.5 2.5v7H10.5M3.25 4.75h4.5l2.5 2.5v7h-7v-9.5Z"
        stroke="currentColor"
        strokeLinejoin="round"
      />
      <path d="M7.75 4.75v2.5h2.5M9.75 1.75v2.5h2.5" stroke="currentColor" />
    </IconBase>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeLinecap="round" />
    </IconBase>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M3.5 4.5h9M6 4.5v-2h4v2M5 6.5v6M8 6.5v6M11 6.5v6M4.5 4.5l.5 9h6l.5-9"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

export function ArchiveIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M2.75 3.25h10.5v2.5H2.75v-2.5Z" stroke="currentColor" />
      <path d="M3.75 5.75v7h8.5v-7M6.25 8h3.5" stroke="currentColor" strokeLinecap="round" />
    </IconBase>
  );
}

export function EditIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="m10.75 2.25 3 3-8.5 8.5h-3v-3l8.5-8.5Z"
        stroke="currentColor"
        strokeLinejoin="round"
      />
      <path d="m9.25 3.75 3 3" stroke="currentColor" />
    </IconBase>
  );
}

export function MoreIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="3.5" cy="8" fill="currentColor" r="1" />
      <circle cx="8" cy="8" fill="currentColor" r="1" />
      <circle cx="12.5" cy="8" fill="currentColor" r="1" />
    </IconBase>
  );
}

export function ChevronIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m5 6 3 3 3-3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </IconBase>
  );
}

export function InsightIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M5.15 11.75c-1.25-.83-2.05-2.22-2.05-3.8A4.9 4.9 0 0 1 8 3.05a4.9 4.9 0 0 1 4.9 4.9c0 1.58-.8 2.97-2.05 3.8M5.7 12.1h4.6M6.45 14h3.1"
        stroke="currentColor"
        strokeLinecap="round"
      />
      <path d="M8 5.65v3.5M6.25 7.4h3.5" stroke="currentColor" strokeLinecap="round" />
    </IconBase>
  );
}
