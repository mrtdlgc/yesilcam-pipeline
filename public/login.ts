export {};
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const form = byId<HTMLFormElement>('loginForm'),
  password = byId<HTMLInputElement>('password'),
  error = byId('loginError');
const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
const hosted = window.APP_HOSTED;
let mode: 'login' | 'signup' | 'recover' = 'login';
function changeMode(value: typeof mode) {
  mode = value;
  byId('loginIdentity').hidden = !hosted || mode !== 'login';
  byId('signupEmail').hidden = mode === 'login';
  byId('signupUsername').hidden = mode !== 'signup';
  byId('recoverCode').hidden = mode !== 'recover';
  byId<HTMLInputElement>('login').required = hosted && mode === 'login';
  byId<HTMLInputElement>('email').required = mode !== 'login';
  byId<HTMLInputElement>('username').required = mode === 'signup';
  byId<HTMLInputElement>('recoveryCode').required = mode === 'recover';
  password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  password.minLength = mode === 'login' ? 1 : 12;
  password.value = '';
  error.textContent = '';
  byId('passwordLabel').textContent =
    mode === 'recover' ? 'New password' : hosted ? 'Password' : 'Workspace password';
  submit.textContent =
    mode === 'signup' ? 'Create account' : mode === 'recover' ? 'Reset password' : 'Sign in';
  byId('loginTitle').textContent =
    mode === 'signup'
      ? 'Your own studio.'
      : mode === 'recover'
        ? 'Recover your account.'
        : 'Enter the studio.';
}
if (hosted) {
  byId('accountModes').hidden = false;
  byId('loginEyebrow').textContent = 'YOUR FILMS. YOUR CONNECTIONS.';
  byId('sessionNote').textContent =
    'Sign in for 12 hours. Bring your own provider keys; your films stay on your computer.';
  byId('signInMode').onclick = () => changeMode('login');
  byId('signUpMode').onclick = () => changeMode('signup');
  byId('recoverMode').onclick = () => changeMode('recover');
  void fetch(`${window.APP_BASE_PATH || ''}/api/auth/session`)
    .then((r) => r.json())
    .then((data) => {
      byId('signUpMode').hidden = data.signupEnabled === false;
    });
}
changeMode('login');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  submit.disabled = true;
  error.textContent = '';
  try {
    const body =
      mode === 'signup'
        ? {
            email: byId<HTMLInputElement>('email').value,
            username: byId<HTMLInputElement>('username').value,
            password: password.value,
          }
        : mode === 'recover'
          ? {
              email: byId<HTMLInputElement>('email').value,
              recoveryCode: byId<HTMLInputElement>('recoveryCode').value,
              newPassword: password.value,
            }
          : { login: byId<HTMLInputElement>('login').value, password: password.value };
    const response = await fetch(`${window.APP_BASE_PATH || ''}/api/auth/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Yesilcam-Request': '1' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Sign-in failed. Try again.');
    password.value = '';
    byId<HTMLInputElement>('recoveryCode').value = '';
    if (data.recoveryCode) {
      form.hidden = true;
      byId('accountModes').hidden = true;
      byId('recoveryResult').hidden = false;
      byId<HTMLTextAreaElement>('newRecoveryCode').value = data.recoveryCode;
      const link = byId<HTMLAnchorElement>('continueLink');
      link.href = `${window.APP_BASE_PATH || ''}/${mode === 'recover' ? 'login' : ''}`;
      link.textContent =
        mode === 'recover' ? 'Sign in with your new password' : 'Continue to the studio';
    } else window.location.replace(`${window.APP_BASE_PATH || ''}/`);
  } catch (failure) {
    error.textContent = failure.message || 'Unable to reach the studio';
  } finally {
    submit.disabled = false;
  }
});
