let authPromise: Promise<string> | null = null;

// generate a token with the neuroglancer-auth service using google oauth2
async function authorize(auth_url: string) {
	// establish session so that the websocket can be associated with this session
	// and then used when google redirects to oauth2callback
	// there may be a way to get around this additional request by modifying the websocket library on the server
	await fetch(`https://${auth_url}/establish_session?origin=${encodeURI(window.location.origin)}`, {
		credentials: 'include'
	});

	return await new Promise<string>((f, _r) => {
		const socket = new WebSocket(`wss://${auth_url}/authorize`);

		let auth_popup: Window | null = null;

		socket.onmessage = function (msg) {
			if (msg.data.startsWith('http')) {
				auth_popup = window.open(msg.data);

				if (!auth_popup) {
					alert('Allow popups on this page to authenticate');
				}
			} else {
				auth_popup!.close();
				f(msg.data);
			}
		}
	});
}

// returns the token required to authenticate with "neuroglancer-auth" requiring services
export function reauthenticate(): Promise<string> {
	if (!authPromise) {
		const existingToken = localStorage.getItem('auth_token');

		if (existingToken) {
			authPromise = new Promise((f, _r) => {
				f(existingToken);
			});
		} else {
			authPromise = authorize('dev.dynamicannotationframework.com/auth').then((token) => {
				localStorage.setItem('auth_token', token);
				return token;
			});
		}
	}

	return authPromise;
}
