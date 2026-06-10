import { signIn } from '../lib/auth';

export default function SignIn() {
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center gap-6 px-6 text-center">
      <div>
        <h1 className="text-2xl font-semibold text-emerald-400">⛽ Tankstelle</h1>
        <p className="mt-2 text-sm text-slate-400">
          Sign in with your Microsoft account to continue.
        </p>
      </div>
      <button
        onClick={() => void signIn()}
        className="rounded-lg bg-emerald-500 px-5 py-2.5 font-semibold text-emerald-950"
      >
        Sign in with Microsoft
      </button>
    </div>
  );
}
