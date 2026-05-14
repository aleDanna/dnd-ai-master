'use client';
import * as React from 'react';
import { Drawer as Vaul } from 'vaul';

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  /** When true the drawer opens at ~60% height instead of the default 88%. */
  peek?: boolean;
}

export function Drawer({ open, onOpenChange, children, peek = false }: DrawerProps) {
  return (
    <Vaul.Root open={open} onOpenChange={onOpenChange}>
      <Vaul.Portal>
        <Vaul.Overlay
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            backdropFilter: 'blur(4px)',
            zIndex: 50,
          }}
        />
        <Vaul.Content
          style={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 51,
            display: 'flex',
            flexDirection: 'column',
            maxHeight: peek ? '60%' : '88%',
            background: 'var(--bg-elev)',
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            borderTop: '1px solid var(--border-strong)',
            outline: 'none',
          }}
        >
          <Vaul.Title style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 }}>
            Drawer
          </Vaul.Title>
          <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 8, flexShrink: 0 }}>
            <div
              style={{
                width: 36,
                height: 4,
                borderRadius: 2,
                background: 'var(--fg-subtle)',
                opacity: 0.4,
              }}
            />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>{children}</div>
        </Vaul.Content>
      </Vaul.Portal>
    </Vaul.Root>
  );
}
