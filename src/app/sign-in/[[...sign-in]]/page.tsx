import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg)',
      }}
    >
      <SignIn appearance={{ variables: { colorPrimary: '#7A4FB8' } }} />
    </main>
  );
}
