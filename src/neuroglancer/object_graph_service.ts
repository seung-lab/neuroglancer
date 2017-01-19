

let GRAPH_BASE_URL = 'localhost:8888';

export function setGraphServerURL (url: string) : void {
	GRAPH_BASE_URL = url;
}

/* Directs the graph server to merge 
 * the given nodes into a single object.
 * 
 * This will remove them from other objects.
 */
export function mergeNodes<T> (nodes: T[]) : Promise<Response> {
	return fetch(`http://${GRAPH_BASE_URL}/1.0/object/`, {
	  method: "POST",
	  body: JSON.stringify(nodes),
	})
	.catch(function (error) {
		console.error(error);
	})
	.then(function (resp) {
		console.log("yay merged");
		return resp;
	});
}

/* Fetches all registered objects in the dataset
 * with their nodes. Not scalable, will be chunked in future.
 */
export function getObjectList () : Promise<Response> {
	return fetch(`http://${GRAPH_BASE_URL}/1.0/object/`)
		.catch(function (error) {
			console.error(error);
		})
		.then(function (response) {
			return response.json();
		});
}





