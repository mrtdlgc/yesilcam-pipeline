export {};
const form = document.getElementById('loginForm') as HTMLFormElement;
const password = document.getElementById('password') as HTMLInputElement;
const error = document.getElementById('loginError') as HTMLParagraphElement;
const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  submit.disabled = true;
  error.textContent = '';
  try {
    const response = await fetch(`${window.APP_BASE_PATH || ''}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Yesilcam-Request': '1' },
      body: JSON.stringify({ password: password.value }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Sign-in failed. Try again.');
    }
    password.value = '';
    window.location.replace(`${window.APP_BASE_PATH || ''}/`);
  } catch (failure) {
    error.textContent = failure.message || 'Unable to reach the studio';
  } finally {
    submit.disabled = false;
  }
});
