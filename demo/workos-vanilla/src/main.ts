import './style.css';
import { initAuth, getUser, signIn, signUp, signOut, onAuthStateChange } from './auth';

// Initialize auth and render UI
async function main(): Promise<void> {
  const app = document.querySelector<HTMLDivElement>('#app')!;

  // Show loading state
  app.innerHTML = `
    <section id="center">
      <p>Loading...</p>
    </section>
  `;

  try {
    // Initialize AuthKit client (handles callback if present)
    await initAuth();

    // Render the app
    render(app);

    // Re-render on auth state changes
    onAuthStateChange(() => render(app));
  } catch (error) {
    console.error('Auth initialization failed:', error);
    app.innerHTML = `
      <section id="center">
        <h1>Authentication Error</h1>
        <p>${error instanceof Error ? error.message.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!)) : 'Unknown error'}</p>
      </section>
    `;
  }
}

function render(app: HTMLDivElement): void {
  const user = getUser();

  if (user) {
    // Authenticated state
    app.innerHTML = `
      <section id="center">
        <div class="user-card">
          ${user.profilePictureUrl ? `<img src="${user.profilePictureUrl}" alt="Profile" class="avatar" />` : '<div class="avatar-placeholder"></div>'}
          <h1>Welcome, ${user.firstName || user.email}!</h1>
          <p class="email">${user.email}</p>
          ${'organizationId' in user && user.organizationId ? `<p class="org">Organization: ${user.organizationId}</p>` : ''}
        </div>
        <div class="actions">
          <button id="sign-out" type="button" class="btn btn-secondary">Sign Out</button>
        </div>
        <div class="user-details">
          <h2>User Details</h2>
          <pre><code>${JSON.stringify(user, null, 2)}</code></pre>
        </div>
      </section>
    `;

    // Attach sign out handler
    document.getElementById('sign-out')?.addEventListener('click', () => {
      signOut();
    });
  } else {
    // Unauthenticated state
    app.innerHTML = `
      <section id="center">
        <div class="hero-text">
          <h1>WorkOS AuthKit Demo</h1>
          <p>Vanilla JavaScript + TypeScript</p>
        </div>
        <div class="actions">
          <button id="sign-in" type="button" class="btn btn-primary">Sign In</button>
          <button id="sign-up" type="button" class="btn btn-secondary">Sign Up</button>
        </div>
      </section>
    `;

    // Attach sign in/up handlers (must be on user gesture)
    document.getElementById('sign-in')?.addEventListener('click', async () => {
      await signIn();
    });

    document.getElementById('sign-up')?.addEventListener('click', async () => {
      await signUp();
    });
  }
}

// Start the app
main();
