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

  // Clear existing content
  app.innerHTML = '';

  if (user) {
    // Authenticated state - build DOM programmatically
    const section = document.createElement('section');
    section.id = 'center';

    const h1 = document.createElement('h1');
    h1.textContent = 'Welcome!';
    section.appendChild(h1);

    const userInfo = document.createElement('div');
    userInfo.className = 'user-info';

    // Profile picture - validate URL scheme
    if (user.profilePictureUrl) {
      try {
        const url = new URL(user.profilePictureUrl);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          const img = document.createElement('img');
          img.setAttribute('src', user.profilePictureUrl);
          img.setAttribute('alt', 'Profile');
          img.className = 'avatar';
          userInfo.appendChild(img);
        }
      } catch {
        // Invalid URL - skip image
      }
    }

    // Email
    const emailP = document.createElement('p');
    const emailStrong = document.createElement('strong');
    emailStrong.textContent = 'Email:';
    emailP.appendChild(emailStrong);
    emailP.appendChild(document.createTextNode(' ' + user.email));
    userInfo.appendChild(emailP);

    // Name (if available)
    if (user.firstName) {
      const nameP = document.createElement('p');
      const nameStrong = document.createElement('strong');
      nameStrong.textContent = 'Name:';
      nameP.appendChild(nameStrong);
      const fullName = user.firstName + (user.lastName ? ' ' + user.lastName : '');
      nameP.appendChild(document.createTextNode(' ' + fullName));
      userInfo.appendChild(nameP);
    }

    // User ID
    const idP = document.createElement('p');
    const idStrong = document.createElement('strong');
    idStrong.textContent = 'User ID:';
    idP.appendChild(idStrong);
    idP.appendChild(document.createTextNode(' '));
    const code = document.createElement('code');
    code.textContent = user.id;
    idP.appendChild(code);
    userInfo.appendChild(idP);

    section.appendChild(userInfo);

    // Sign out button
    const signOutBtn = document.createElement('button');
    signOutBtn.id = 'sign-out-btn';
    signOutBtn.type = 'button';
    signOutBtn.textContent = 'Sign Out';
    signOutBtn.addEventListener('click', async () => {
      await signOut();
    });
    section.appendChild(signOutBtn);

    app.appendChild(section);
  } else {
    // Unauthenticated state - build DOM programmatically
    const section = document.createElement('section');
    section.id = 'center';

    const h1 = document.createElement('h1');
    h1.textContent = 'WorkOS AuthKit Demo';
    section.appendChild(h1);

    const p = document.createElement('p');
    p.textContent = 'Sign in to get started';
    section.appendChild(p);

    const signInBtn = document.createElement('button');
    signInBtn.id = 'sign-in-btn';
    signInBtn.type = 'button';
    signInBtn.textContent = 'Sign In with WorkOS';
    signInBtn.addEventListener('click', async () => {
      await signIn();
    });
    section.appendChild(signInBtn);

    app.appendChild(section);
  }
}

// Start the app
init();
