let authPromise: Promise<string> | null = null;

import {CancellationToken, uncancelableToken} from 'neuroglancer/util/cancellation';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value.ts';
import {registerPromiseRPC, RPC, registerRPC} from 'neuroglancer/worker_rpc';

import {AUTHENTICATION_GET_SHARED_TOKEN_RPC_ID, AUTHENTICATION_REAUTHENTICATE_RPC_ID, authFetchWithSharedValue, SharedAuthToken} from 'neuroglancer/authentication/base.ts';

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
// client currently only supports a single token in use at a time
async function reauthenticate(auth_url: string, used_token?: string|SharedAuthToken): Promise<string> {
	// this should never happen but this allows the interface to be the same between front and backend
	if (used_token && (typeof used_token !== "string")) {
		used_token = used_token.value || undefined;
	}
	used_token = <string>used_token;
	
	const existingToken = localStorage.getItem('auth_token');
	const existingAuthURL = localStorage.getItem('auth_url');

	// if we don't have a promise or we are authenticating with a new auth url
	// or if we failed to authenticate with our existing token 
	if (!authPromise || existingAuthURL !== auth_url || used_token === existingToken) {
		if (existingToken && existingAuthURL === auth_url && existingToken !== used_token) {
			authTokenShared!.value = existingToken;
			return existingToken;
		} else {
			const token = await authorize(auth_url);
			localStorage.setItem('auth_token', token);
			localStorage.setItem('auth_url', auth_url);
			authTokenShared!.value = token;
			return token;
		}
	}

	return authPromise;
}

let authTokenShared: SharedAuthToken |undefined;

export function initAuthTokenSharedValue(rpc: RPC) {
	authTokenShared = SharedWatchableValue.make(rpc, localStorage.getItem("auth_token"));
}

// allow backend thread to access the shared token rpc id so that it can initialize the shared value
registerPromiseRPC<number>(
	AUTHENTICATION_GET_SHARED_TOKEN_RPC_ID,
	function() {	
		return new Promise((f) => {
			f({value: authTokenShared!.rpcId!});
		});
	});

// allow backend to trigger reauthentication when shared value token is invalid
registerRPC(
	AUTHENTICATION_REAUTHENTICATE_RPC_ID,
	function({auth_url, used_token}) {
		return reauthenticate(auth_url, used_token).then((token) => {
			return {value: token};
		});
	});

export async function authFetch(input: RequestInfo, init = {}, cancelToken: CancellationToken = uncancelableToken, retry = 1): Promise<Response> {
	return authFetchWithSharedValue(reauthenticate, authTokenShared!, input, init, cancelToken, retry);
}
