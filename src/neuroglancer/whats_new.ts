import axios from 'axios';
import showdown from 'showdown';
import {Overlay} from 'neuroglancer/overlay';
import {Viewer} from 'neuroglancer/viewer';

// TODO: Clean up
// TODO: css
// require('./whats_new.css');

export const snoopWhatsNew = async (viewer: Viewer) => {
  let
      url = `https://script.google.com/macros/s/AKfycbzmPIJMb9z_o0_2vFdNeTIgrur_b_2tFO2A3pP9w9r7RVzub5E/exec`,
      WNCommits = JSON.parse(localStorage.getItem('WNCommits') || '[]'),
      headers = {
          'Content-Type': 'text/plain;charset=utf-8',
      },
      data = JSON.stringify({
         path: 'some/path',
         // since: (WNCommits.length) ? WNCommits[0].commit.author.date : void(0)
      });

  let GHCommits = JSON.parse((await axios({ method: 'post', headers, url, data })).data);

  if (GHCommits.length > WNCommits.length) {
    let newCommits = GHCommits.slice(0, GHCommits.length - WNCommits.length);
    let description = newCommits.reduce((acc, cur) => )
    return new WhatsNewDialog(viewer, description);
  }
};

export class WhatsNewDialog extends Overlay {
  constructor(public viewer: Viewer, description: string = '') {
    super();
    let {content} = this;

    const converter = new showdown.Converter();
    let modal = document.createElement('div');

    content.appendChild(modal);

    let header = document.createElement('h3');
    header.textContent = `What's New`;
    modal.appendChild(header);

    let body = document.createElement('p');
    body.innerHTML = converter.makeHtml(description);
    modal.appendChild(body);

    let okBtn = document.createElement('button');
    okBtn.textContent = 'Ok';
    okBtn.onclick = () => this.dispose();

    modal.appendChild(okBtn);
    modal.onblur = () => this.dispose();
    modal.focus();
  }
}
