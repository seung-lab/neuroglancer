/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

////////// required to implement constructor
import {DisplayContext} from 'neuroglancer/display_context';
////////// end required to implement constructor

// ////////// required to implement makeUI
// import {RootLayoutContainer} from 'neuroglancer/layer_groups_layout';
// ////////// end required to implement makeUI

import {authTokenShared, authFetch} from 'neuroglancer/authentication/frontend';

import {Viewer} from 'neuroglancer/viewer';

import Vue from 'vue'

interface LoggedInUser {
    name: string;
    email: string;
}

interface VueData {
    loggedInUser: LoggedInUser|null
}

export class ExtendViewer extends Viewer {
    constructor(public display: DisplayContext) {
        super(display, {
            showUIControls: true,
            showPanelBorders: true,
            showLayerDialog: true,
        });

        const mainApp = new Vue({
            el: "#vueApp",
            data(): VueData {
                return {
                    loggedInUser: null
                };
            },
            methods: {
                logout: async () => {
                    const existingToken = localStorage.getItem('auth_token');
                    const existingAuthURL = localStorage.getItem('auth_url');

                    if (existingToken && existingAuthURL) {
                        await authFetch(`https://${existingAuthURL}/logout`).then((res) => {
                            return res.json();
                        });

                        localStorage.removeItem('auth_token');
                        localStorage.removeItem('auth_url');

                        authTokenShared!.value = null;
                    }
                }
            }
        });

        console.log('mainapp', mainApp);

        

        authTokenShared!.changed.add(() => {
            console.log('auth value changed!', authTokenShared!.value);
            tryGettingUser();
        });
        

        function tryGettingUser() {
            const existingToken = localStorage.getItem('auth_token');
            const existingAuthURL = localStorage.getItem('auth_url');

            if (existingToken && existingAuthURL) {
                authFetch(`https://${existingAuthURL}/user/me`).then((res) => {
                    return res.json();
                }).then((res) => {
                    mainApp.loggedInUser = {
                        name: res.name,
                        email: res.email
                    }
                });
            } else {
                mainApp.loggedInUser = null;
            }
        }

        tryGettingUser();

        // change tile
        // setInterval(() => {
        //     this.navigationState.pose.translateVoxelsRelative(vec3.fromValues(0, 0, -1));
        // }, 200);

        // change layout
        // setTimeout(() => {
        //     this.layout.restoreState('3d');
        // }, 2000);
    }

    // protected makeUI() {
    //     super.makeUI();

    //     // const em_layer = this.layerSpecification.getLayer("image_stitch_v02", {
    //     //     source: "precomputed://gs://neuroglancer-public-data/kasthuri2011/image_color_corrected",
    //     //     type: "image",
    //     //     name: "whatever"
    //     // });

    //     // this.selectedLayer.layerManager.addManagedLayer(em_layer);

    //     // const segmentation_layer = this.layerSpecification.getLayer("whatever2", {
    //     //     source: "precomputed://gs://neuroglancer-public-data/kasthuri2011/ground_truth",
    //     //     type: "segmentation",
    //     //     name: "whatever2"
    //     // });

    //     // this.selectedLayer.layerManager.addManagedLayer(segmentation_layer);
    // }
}
