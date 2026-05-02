'use client';
import { Icon } from '@/components/ui/icon';

export function SpinningDie({ size = 16 }: { size?: number }) {
  return (
    <span style={{ display: 'inline-block', animation: 'spin 1.2s linear infinite' }}>
      <Icon name="logo-d20" size={size} />
    </span>
  );
}
