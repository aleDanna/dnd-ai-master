import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export function ExpiredInviteCard() {
  return (
    <div style={{ maxWidth: 480, margin: '80px auto', padding: '0 24px' }}>
      <Card>
        <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>Invite link expired</h2>
        <p style={{ color: 'var(--fg-muted)', fontSize: 14, lineHeight: 1.5, marginBottom: 16 }}>
          This invite link is no longer valid (expired, revoked, or fully used). Ask the host for a new link.
        </p>
        <Link href="/hub"><Button variant="primary" size="md">Back to hub</Button></Link>
      </Card>
    </div>
  );
}
