import { FormEvent, useState } from 'react';
import { CrewApiError, loginCrewApi, resolveCrewToken } from '../api/crewApi';
import type { CrewLoginData } from '../api/apiTypes';
import { isCrewDeveloperMode } from '../devMode';
import type { Translations } from '../i18n';

type LoginScreenProps = {
  onLogin: (token: string, session: CrewLoginData) => void;
  t: Translations;
};

export function LoginScreen({ onLogin, t }: LoginScreenProps) {
  const [email, setEmail] = useState('');
  const [pin, setPin] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown> | null>(null);
  const isDeveloperMode = isCrewDeveloperMode();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setDiagnostics(null);
    setIsSubmitting(true);

    try {
      const data = await loginCrewApi({
        email: email.trim(),
        pin: pin.trim()
      });
      const token = resolveCrewToken(data);

      if (!token) {
        throw new CrewApiError(t.errors.missingCrewToken, {
          phase: 'login-token-resolution',
          responseData: data
        });
      }

      onLogin(token, data);
    } catch (err) {
      setError(err instanceof CrewApiError && err.message === t.errors.missingCrewToken ? err.message : t.errors.unableToLogin);
      setDiagnostics(err instanceof CrewApiError ? err.diagnostics : null);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="crew-login-screen">
      <section className="crew-login-card" aria-labelledby="crew-login-title">
        <div className="crew-brand">
          <div className="crew-brand-mark">T</div>
          <div>
            <p className="crew-kicker">{t.app.brandName}</p>
            <h1 id="crew-login-title">{t.app.shortName}</h1>
          </div>
        </div>

        <p className="crew-login-copy">{t.auth.instructions}</p>

        <form className="crew-login-form" onSubmit={handleSubmit}>
          <label>
            <span>{t.auth.emailLabel}</span>
            <input
              autoComplete="email"
              inputMode="email"
              name="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder={t.auth.emailPlaceholder}
              required
              type="email"
              value={email}
            />
          </label>

          <label>
            <span>{t.auth.pinLabel}</span>
            <input
              autoComplete="current-password"
              inputMode="numeric"
              name="pin"
              onChange={(event) => setPin(event.target.value)}
              placeholder={t.auth.pinPlaceholder}
              required
              type="password"
              value={pin}
            />
          </label>

          {error ? <div className="crew-error" role="alert">{error}</div> : null}

          {isDeveloperMode && diagnostics ? (
            <details className="crew-diagnostics" open>
              <summary>{t.auth.temporaryDiagnostics}</summary>
              <pre>{JSON.stringify(diagnostics, null, 2)}</pre>
            </details>
          ) : null}

          <button className="crew-primary-button" disabled={isSubmitting} type="submit">
            {isSubmitting ? t.auth.signingIn : t.auth.signIn}
          </button>
        </form>
      </section>
    </main>
  );
}
