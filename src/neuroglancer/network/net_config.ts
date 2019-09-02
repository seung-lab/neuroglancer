import {NetworkOverlay} from 'neuroglancer/network/net_overlay';
import {br, brp, Network} from 'neuroglancer/network/net_widget';
import {Viewer} from 'neuroglancer/viewer';

export class NetworkConfiguration extends NetworkOverlay {
  constructor(public viewer: Viewer, public net: Network) {
    super(viewer, net);
    const {labelWrap, simpleInput, /*simpleItem,*/ content} = this;
    const modal = document.createElement('div');
    content.appendChild(modal);

    let header = document.createElement('h3');
    header.textContent = 'Network Configuration';
    const uidField = labelWrap('ID', [
      ' ', simpleInput({id: 'net-uid', value: net.settings.user.id.toString(), disabled: true})
    ]);
    const connectBtn = document.createElement('button');
    connectBtn.id = 'net-connect-button';
    connectBtn.innerHTML = 'Connect';
    connectBtn.addEventListener('click', () => {
      const host = <HTMLInputElement>document.getElementById('net-hostaddr');
      net.settings.host = host.value;
      net.connect();
    });
    const hostField = labelWrap(
        'Host',
        [' ', simpleInput({id: 'net-hostaddr', value: net.settings.host}), ' ', connectBtn]);
    const applyBtn = document.createElement('button');
    applyBtn.innerHTML = 'Apply Changes';
    applyBtn.addEventListener('click', () => this.apply());
    const nickField = labelWrap(
        'Nickname', [' ', simpleInput({id: 'net-nick', value: net.settings.user.name || ''})]);

    let chanArr = <(string | HTMLElement)[]>[br()];
    let iter = 0;
    for (let cid in net.settings.user.chan) {
      let chanFields = this.addChan(iter);
      if (!iter) {
        chanFields.removeChild(chanFields.lastChild!);  // Remove remove button
        chanFields.removeChild(chanFields.lastChild!);  // Remove space
        (<HTMLInputElement>chanFields.firstChild).disabled = true;
      }
      (<HTMLInputElement>chanFields.firstChild).value = cid;
      (<HTMLInputElement>chanFields.firstChild).dataset['prev'] = cid;
      chanFields.appendChild(br());
      chanArr = [...chanArr, chanFields];
      iter++;
    }
    const chanGroup = labelWrap('Channels', chanArr, {id: 'net-channels-group'});
    const newChannel = document.createElement('button');
    newChannel.id = 'net-addchannel-button';
    newChannel.innerHTML = '+';
    newChannel.addEventListener('click', () => {
      const channels = <HTMLInputElement[]>Array.from(document.querySelectorAll('.net-cid'));
      const it = channels.length;
      const chanFields = this.addChan(it);
      chanFields.appendChild(br());
      chanGroup.appendChild(chanFields);
    });
    const syncField = labelWrap('Sync Settings', []);

    const buildArr = [
      header, ...brp(uidField), ...brp(hostField), ...brp(applyBtn), ...brp(nickField), chanGroup,
      ...brp(newChannel), ...brp(syncField)
    ];
    modal.append(...buildArr);

    const oldNgBtn = document.createElement('button');
    oldNgBtn.id = '?-goBackButton';
    oldNgBtn.innerHTML = 'Return to Old Neuroglancer';
    oldNgBtn.addEventListener('click', () => {
      if (!window.location.host.includes('localhost')) {
        window.location.host = 'www.neuromancer-seung-import.appspot.com';
      }
    });
    modal.append(oldNgBtn);
  }

  apply() {
    const nick = (<HTMLInputElement>document.getElementById('net-nick')!).value;
    if (nick !== '' && nick !== this.net.settings.user.name) {
      this.net.settings.user.name = nick;
      this.net.nickname();
    }

    const channels = <HTMLInputElement[]>Array.from(document.querySelectorAll('.net-cid'));
    for (let field of channels) {
      const val = field.value;
      if (val !== '' && !this.net.settings.user.chan[val]) {
        field.dataset['prev'] = field.value;
        this.net.settings.user.chan[val] = 1;
        this.net.channel(val, true);
      }
    }
  }

  remChannelBtnBuilder =
      (id: string) => {
        const remove = document.createElement('button');
        remove.innerHTML = '-';
        remove.classList.add('net-remchannel-button');
        remove.addEventListener('click', () => {
          if (this.net.ws) {
            const target = <HTMLInputElement>document.getElementById(id);
            const key = target.dataset['prev']!;
            if (key) {
              this.net.channel(key, false);
              delete this.net.settings.user.chan[key];
            }
            const chanGroup = <HTMLInputElement>document.getElementById('net-channels-group');
            const container = target.parentElement!;
            chanGroup.removeChild(container);
          }
        });
        return remove;
      }

  addChan = (index: number) => {
    const textbox = document.createElement('input');
    textbox.classList.add('net-cid');
    textbox.id = `cid-idx-${index.toString()}`;
    textbox.type = 'text';
    const container = document.createElement('span');
    container.append(...[textbox, ' ', this.remChannelBtnBuilder(textbox.id)]);
    return container;
  }
}
