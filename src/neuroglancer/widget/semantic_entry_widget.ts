
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {Uint64} from 'neuroglancer/util/uint64';
import {Signal} from 'signals';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';

require('neuroglancer/noselect.css');
require('./semantic_entry_widget.css');

type ItemElement = HTMLButtonElement;


export class SemanticEntryWidget extends RefCounted {

  get segmentColorHash() { return this.displayState.segmentColorHash; }

  element = document.createElement('div');
  semanticApplied = new Signal();
  lastSemantic: string;
  input: any;
  ul: any;
  private items = new Array<ItemElement>();


  constructor(public displayState: SegmentationDisplayState) {
    super();
    let {element} = this;
    element.className = 'semantic-entry noselect';
    element.innerHTML = `
    <hr>
    Semantic classes
    <form>
      <label>
        + <input></input>
      </label>
    </form>
    <ul></ul>
    <hr>`;
    
    let form = element.querySelector('form');
    this.input = element.querySelector('input');
    this.ul = element.querySelector('ul');
    
    this.registerSignalBinding(
        displayState.segmentColorHash.changed.add(this.handleColorChanged, this));

    this.registerEventListener(form, 'submit', (event: Event) => {
      event.preventDefault();
      if (this.validateInput()) {
        this.input.classList.remove('valid-input', 'invalid-input');
        this.addElement(this.input.value);
        this.input.value = '';
      }
    });
    this.registerEventListener(form, 'input', () => {
      if (this.input.value === '') {
        this.input.classList.remove('valid-input', 'invalid-input');
        return;
      }
      if (this.validateInput()) {
        this.input.classList.remove('invalid-input');
      } else {
        this.input.classList.add('invalid-input');
      }
    });
  }

  addElement(name: string) {
    var li = document.createElement('li');
    let button = document.createElement('button');
    li.appendChild(button)
    button.innerHTML = `${name}`
    let self = this;
    button.className = `${this.items.length}`;
    button.addEventListener('click', function(this: ItemElement) {
      self.semanticApplied.dispatch(parseInt(button.className));
      self.lastSemantic = this.innerHTML;
    });
    this.setItemColor(this.items.length, button);

    this.ul.appendChild(li);
    this.items.push(button);
  }

  validateInput() { return true; }

  private setItemColor(idx:number, itemElement: ItemElement) {
    itemElement.style.backgroundColor = this.segmentColorHash.computeCssColor(new Uint64(idx));
  }

  private handleColorChanged() {
    for (var i = this.items.length - 1; i >= 0; i--) {
      this.setItemColor(i, this.items[i]);
    }
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
};
