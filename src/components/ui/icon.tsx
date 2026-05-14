import * as React from 'react';

export type IconName =
  | 'dice' | 'heart' | 'shield' | 'sword' | 'spell' | 'book' | 'chat' | 'send'
  | 'plus' | 'arrow-right' | 'arrow-left' | 'settings' | 'sparkle' | 'check'
  | 'x' | 'user' | 'more' | 'logo-d20'
  | 'volume' | 'pause'
  | 'image' | 'menu' | 'copy' | 'chevron-down' | 'chevron-up'
  | 'globe' | 'compass' | 'flame' | 'star' | 'eye';

export interface IconProps extends Omit<React.SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
  color?: string;
}

export function Icon({ name, size = 16, color, style, ...rest }: IconProps) {
  const baseProps = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    style: { color, ...style },
    ...rest,
  };

  switch (name) {
    case 'dice':
      return (
        <svg {...baseProps}>
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <circle cx="8" cy="8" r="1.2" fill="currentColor" />
          <circle cx="16" cy="16" r="1.2" fill="currentColor" />
          <circle cx="16" cy="8" r="1.2" fill="currentColor" />
          <circle cx="8" cy="16" r="1.2" fill="currentColor" />
        </svg>
      );
    case 'heart':
      return <svg {...baseProps}><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z" /></svg>;
    case 'shield':
      return <svg {...baseProps}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>;
    case 'sword':
      return <svg {...baseProps}><path d="M14.5 17.5 3 6V3h3l11.5 11.5" /><path d="m13 19 6-6" /><path d="m16 16 4 4" /><path d="m19 21 2-2" /></svg>;
    case 'spell':
    case 'sparkle':
      return <svg {...baseProps}><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z" /></svg>;
    case 'book':
      return <svg {...baseProps}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" /></svg>;
    case 'chat':
      return <svg {...baseProps}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>;
    case 'send':
      return <svg {...baseProps}><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></svg>;
    case 'plus':
      return <svg {...baseProps}><path d="M12 5v14M5 12h14" /></svg>;
    case 'arrow-right':
      return <svg {...baseProps}><path d="M5 12h14M13 5l7 7-7 7" /></svg>;
    case 'arrow-left':
      return <svg {...baseProps}><path d="M19 12H5M12 5l-7 7 7 7" /></svg>;
    case 'settings':
      return <svg {...baseProps}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>;
    case 'check':
      return <svg {...baseProps}><path d="M20 6 9 17l-5-5" /></svg>;
    case 'x':
      return <svg {...baseProps}><path d="M18 6 6 18M6 6l12 12" /></svg>;
    case 'user':
      return <svg {...baseProps}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>;
    case 'more':
      return <svg {...baseProps}><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></svg>;
    case 'logo-d20':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" style={{ color, ...style }}>
          <polygon points="16,2 29,9 29,23 16,30 3,23 3,9" />
          <polygon points="16,2 29,9 16,16 3,9" />
          <line x1="16" y1="16" x2="16" y2="30" />
          <line x1="16" y1="16" x2="29" y2="23" />
          <line x1="16" y1="16" x2="3" y2="23" />
        </svg>
      );
    case 'volume':
      return (
        <svg {...baseProps}>
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
        </svg>
      );
    case 'pause':
      return (
        <svg {...baseProps}>
          <rect x="6" y="4" width="4" height="16" rx="1" />
          <rect x="14" y="4" width="4" height="16" rx="1" />
        </svg>
      );
    case 'image':
      return (
        <svg {...baseProps}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="9" cy="9" r="2" />
          <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
        </svg>
      );
    case 'menu':
      return <svg {...baseProps}><path d="M4 6h16M4 12h16M4 18h16" /></svg>;
    case 'copy':
      return (
        <svg {...baseProps}>
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      );
    case 'chevron-down':
      return <svg {...baseProps}><polyline points="6 9 12 15 18 9" /></svg>;
    case 'chevron-up':
      return <svg {...baseProps}><polyline points="18 15 12 9 6 15" /></svg>;
    case 'globe':
      return (
        <svg {...baseProps}>
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      );
    case 'compass':
      return (
        <svg {...baseProps}>
          <circle cx="12" cy="12" r="10" />
          <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
        </svg>
      );
    case 'flame':
      return (
        <svg {...baseProps}>
          <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
        </svg>
      );
    case 'star':
      return (
        <svg {...baseProps}>
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      );
    case 'eye':
      return (
        <svg {...baseProps}>
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
  }
}
