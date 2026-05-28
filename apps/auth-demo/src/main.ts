import './style.css';
import { initAuthKit, getUser, signIn, signOut } from './auth';

// Initialize app
async function init() {
  const app = document.querySelector<HTMLDivElement>('#app')!;

  // Show loading state
  app.innerHTML = `
    <section id="center">
      <h1>WorkOS AuthKit Demo</h1>
      <p>Initializing...</p>
    </section>
  `;

  try {
    // Initialize AuthKit client (MUST await - createClient returns a Promise)
    await initAuthKit();

    // Render based on auth state
    render();
  } catch (error) {
    app.innerHTML = `
      <section id="center">
        <h1>Error</h1>
        <p style="color: red;">${error instanceof Error ? error.message : 'Failed to initialize AuthKit'}</p>
      </section>
    `;
  }
}

function render() {
  const app = document.querySelector<HTMLDivElement>('#app')!;
  const user = getUser();

  if (user) {
    // Authenticated state
    app.innerHTML = `
      <section id="center">
        <h1>Welcome!</h1>
        <div class="user-info">
          ${user.profilePictureUrl ? `<img src="${user.profilePictureUrl}" alt="Profile" class="avatar" />` : ''}
          <p><strong>Email:</strong> ${user.email}</p>
          ${user.firstName ? `<p><strong>Name:</strong> ${user.firstName} ${user.lastName || ''}</p>` : ''}
          <p><strong>User ID:</strong> <code>${user.id}</code></p>
        </div>
        <button id="sign-out-btn" type="button">Sign Out</button>
      </section>
    `;

    // Attach sign out handler
    document.querySelector('#sign-out-btn')?.addEventListener('click', async () => {
      await signOut();
    });
  } else {
    // Unauthenticated state
    app.innerHTML = `
      <section id="center">
        <h1>WorkOS AuthKit Demo</h1>
        <p>Sign in to get started</p>
        <button id="sign-in-btn" type="button">Sign In with WorkOS</button>
      </section>
    `;

    // Attach sign in handler (must be user gesture - click handler)
    document.querySelector('#sign-in-btn')?.addEventListener('click', async () => {
      await signIn();
    });
  }
}

// Start the app
init();
