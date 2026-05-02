import { TopBar } from '@/components/layout/top-bar';

export default function AuthedLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <TopBar />
      {children}
    </div>
  );
}
