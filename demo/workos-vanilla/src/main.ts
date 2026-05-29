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

  // Clear existing content
  app.innerHTML = '';

  if (user) {
    // Authenticated state - build DOM programmatically
    const section = document.createElement('section');
    section.id = 'center';

    // User card
    const userCard = document.createElement('div');
    userCard.className = 'user-card';

    // Profile picture or placeholder - validate URL scheme
    if (user.profilePictureUrl) {
      try {
        const url = new URL(user.profilePictureUrl);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          const img = document.createElement('img');
          img.setAttribute('src', user.profilePictureUrl);
          img.setAttribute('alt', 'Profile');
          img.className = 'avatar';
          userCard.appendChild(img);
        } else {
          const placeholder = document.createElement('div');
          placeholder.className = 'avatar-placeholder';
          userCard.appendChild(placeholder);
        }
      } catch {
        // Invalid URL - show placeholder
        const placeholder = document.createElement('div');
        placeholder.className = 'avatar-placeholder';
        userCard.appendChild(placeholder);
      }
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'avatar-placeholder';
      userCard.appendChild(placeholder);
    }

    // Welcome heading
    const h1 = document.createElement('h1');
    h1.textContent = 'Welcome, ' + (user.firstName || user.email) + '!';
    userCard.appendChild(h1);

    // Email
    const emailP = document.createElement('p');
    emailP.className = 'email';
    emailP.textContent = user.email;
    userCard.appendChild(emailP);

    // Organization (if available)
    if ('organizationId' in user && user.organizationId) {
      const orgP = document.createElement('p');
      orgP.className = 'org';
      orgP.textContent = 'Organization: ' + user.organizationId;
      userCard.appendChild(orgP);
    }

    section.appendChild(userCard);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'actions';

    const signOutBtn = document.createElement('button');
    signOutBtn.id = 'sign-out';
    signOutBtn.type = 'button';
    signOutBtn.className = 'btn btn-secondary';
    signOutBtn.textContent = 'Sign Out';
    signOutBtn.addEventListener('click', () => {
      signOut();
    });
    actions.appendChild(signOutBtn);

    section.appendChild(actions);

    // User details
    const userDetails = document.createElement('div');
    userDetails.className = 'user-details';

    const h2 = document.createElement('h2');
    h2.textContent = 'User Details';
    userDetails.appendChild(h2);

    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = JSON.stringify(user, null, 2);
    pre.appendChild(code);
    userDetails.appendChild(pre);

    section.appendChild(userDetails);

    app.appendChild(section);
  } else {
    // Unauthenticated state - build DOM programmatically
    const section = document.createElement('section');
    section.id = 'center';

    // Hero text
    const heroText = document.createElement('div');
    heroText.className = 'hero-text';

    const h1 = document.createElement('h1');
    h1.textContent = 'WorkOS AuthKit Demo';
    heroText.appendChild(h1);

    const p = document.createElement('p');
    p.textContent = 'Vanilla JavaScript + TypeScript';
    heroText.appendChild(p);

    section.appendChild(heroText);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'actions';

    const signInBtn = document.createElement('button');
    signInBtn.id = 'sign-in';
    signInBtn.type = 'button';
    signInBtn.className = 'btn btn-primary';
    signInBtn.textContent = 'Sign In';
    signInBtn.addEventListener('click', async () => {
      await signIn();
    });
    actions.appendChild(signInBtn);

    const signUpBtn = document.createElement('button');
    signUpBtn.id = 'sign-up';
    signUpBtn.type = 'button';
    signUpBtn.className = 'btn btn-secondary';
    signUpBtn.textContent = 'Sign Up';
    signUpBtn.addEventListener('click', async () => {
      await signUp();
    });
    actions.appendChild(signUpBtn);

    section.appendChild(actions);

    app.appendChild(section);
  }
}

// Start the app
main();
