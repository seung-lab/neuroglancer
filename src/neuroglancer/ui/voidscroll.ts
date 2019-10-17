import ResizeObserver from 'resize-observer-polyfill';

export class VoidScroll {
  private scrollArea: HTMLElement;
  private scrollbar: HTMLElement;
  private scrollbarFiller: HTMLElement;
  private sizeParent: HTMLElement;
  //private heights: number[] = [];
  //private heightMap = new TwoWayMap<number, HTMLElement>();
  private elementHeights: [HTMLElement, number][] = [];
  private elementIndices = new Map<HTMLElement, number>();
  private totalH = 0;
  private loadedElements: HTMLElement[] = [];
  private resizeObserver: ResizeObserver;

  constructor(
      scrollArea: HTMLElement, scrollbar: HTMLElement, scrollbarFiller: HTMLElement,
      sizeParent: HTMLElement) {
    this.scrollArea = scrollArea;
    this.scrollbar = scrollbar;
    this.scrollbarFiller = scrollbarFiller;
    this.sizeParent = sizeParent;

    this.scrollArea.addEventListener('wheel', function(this: VoidScroll, event: WheelEvent) {
      this.scrollbar.scrollTop += event.deltaY;
      this.updateScrollAreaPos();
    }.bind(this));

    this.scrollbar.addEventListener('scroll', function(this: VoidScroll) {
      this.updateScrollAreaPos();
    }.bind(this));

    const parentResizeObserver = new ResizeObserver(this.updateScrollAreaPos.bind(this));
    parentResizeObserver.observe(this.sizeParent);

    this.resizeObserver =
        new ResizeObserver(function(this: VoidScroll, entries: ResizeObserverEntry[]) {
          for (const entry of entries) {
            // on annotation resize, update all subsequent annotation heights
            // TODO: make sure this catches resize due to sidebar adjusted
            const element = <HTMLElement>entry.target;
            const i = this.elementIndices.get(element)!;
            let nextHeight = 0;
            if (i + 1 === this.elementHeights.length) {
              nextHeight = this.totalH;
            }
            else {
              nextHeight = this.elementHeights[i + 1][1];
            }
            const oldHeight = nextHeight - this.elementHeights[i][1];
            const newHeight = element.offsetHeight;
            const delta = newHeight - oldHeight;
            this.shiftHeightsAfter(i + 1, delta);
            
            this.totalH += delta;
            this.updateScrollHeight();
            this.updateScrollAreaPos();

            /*const h = this.heightMap.revGet(element)!; // TODO: make sure the reference is always the same
            const nextI = this.findHeight(h) + 1;
            if (nextI == this.heights.length) continue;
            const oldHeight = this.heights[nextI];
            const newHeight = element.offsetHeight;
            const deltaH = newHeight - oldHeight;
            console.log("Updating " + element.innerHTML + " at h=" + h + ": old height " + oldHeight + ", new height " + newHeight);
            for (let i = nextI; i < this.heights.length; i++) {
              var oldH = this.heights[i];
              this.heights[i] = oldH + deltaH;
              this.heightMap.set(oldH + deltaH, this.heightMap.get(oldH)!);
              this.heightMap.delete(oldH);
            }*/
          }
        }.bind(this));
  }

  private updateScrollAreaPos() {
    for (const e of this.loadedElements) {
      e.classList.add('neuroglancer-annotation-hiding-list-hiddenitem');
    }
    this.loadedElements = [];

    const h = this.scrollbar.scrollTop;
    const startI = this.findHeight(h);
    const endI = this.findHeight(h + this.sizeParent.offsetHeight);
    for (var i = startI; i <= endI; i++) {
      const element = this.elementHeights[i][0];  
      element.classList.remove('neuroglancer-annotation-hiding-list-hiddenitem');
      this.loadedElements.push(element);
    }
    const startH = this.elementHeights[startI][1];
    const offset = startH - h;
    this.scrollArea.style.top = offset + 'px';
    this.scrollArea.style.right = (this.scrollbar.offsetWidth - this.scrollbar.clientWidth) + 'px';
  }

  private addElementHelper(element: HTMLElement) {
    this.scrollArea.appendChild(element);
    const h = element.offsetHeight;
    this.elementIndices.set(element, this.elementHeights.length);
    this.elementHeights.push([element, this.totalH]);
    this.totalH += h;
    element.classList.add('neuroglancer-annotation-hiding-list-hiddenitem');
    this.resizeObserver.observe(element);
  }

  addElements(elements: HTMLElement[]) {
    // append many at once for better performance
    for (const element of elements) {
      this.addElementHelper(element);
    }
    this.updateScrollHeight();
    this.updateScrollAreaPos();
  }

  addElement(element: HTMLElement) {
    this.addElementHelper(element);
    this.updateScrollHeight();
    this.updateScrollAreaPos();
  }

  removeElement(element: HTMLElement) {
    this.resizeObserver.unobserve(element);
    element.classList.remove('neuroglancer-annotation-hiding-list-hiddenitem');
    const h = element.offsetHeight;

    const i = this.elementIndices.get(element)!;
    this.elementHeights.splice(i, 1);
    this.elementIndices.delete(element);
    this.shiftHeightsAfter(i, -h);
    //for all in elementIndices, if element came after removed, then decrement its index
    for (const [el, ind] of this.elementIndices) {
      if (this.elementHeights[ind][1] > i) {
        this.elementIndices.set(el, ind - 1);
      }
    }

    // TODO change
    /*for (var i = 0; i < this.heights.length; i++) {
      const hi = this.heights[i];
      const hElem = this.heightMap.get(hi);
      if (hElem === element) {
        this.heightMap.delete(hi);
        this.heights.splice(i, 1);
        for (var j = i; j < this.heights.length; j++) {
          var oldH = this.heights[j];
          this.heights[j] = oldH - h;
          this.heightMap.set(oldH - h, this.heightMap.get(oldH)!);
          this.heightMap.delete(oldH);
        }
        break;
      }
    }*/

    this.totalH -= h;
    this.scrollArea.removeChild(element);
    this.updateScrollHeight();
    this.updateScrollAreaPos();
  }

  removeAll() {
    this.elementIndices.forEach((_: number, element: HTMLElement) => {
      this.scrollArea.removeChild(element);
    });

    this.elementHeights = [];
    this.elementIndices = new Map<HTMLElement, number>();

    //this.heights = [];
    //this.heightMap = new TwoWayMap<number, HTMLElement>();
    this.totalH = 0;
    this.loadedElements = [];
  }

  scrollTo(element: HTMLElement) {
    /*let h = 0;
    const map = this.heightMap.getMap();
    for (const [hKey, elem] of map) {
      if (elem === element) {
        h = hKey;
        break;
      }
    }*/
    const h = this.elementHeights[this.elementIndices.get(element)!][1];
    // Scrolls just a pixel too far, this makes it look prettier
    this.scrollbar.scrollTop = h - 1;
    this.updateScrollAreaPos();
  }

  private updateScrollHeight() {
    this.scrollbarFiller.style.height = this.totalH + 'px';
  }

  private shiftHeightsAfter(startIndex: number, delta: number) {
    for (let i = startIndex; i < this.elementHeights.length; i++) {
      this.elementHeights[i][1] += delta;
    }
  }

  private findHeight(h: number) {
    // find the position in the heights array of the equal or lower height
    let l = 0;
    let r = this.elementHeights.length - 1;
    while (l <= r) {
      const m = Math.floor((l + r) / 2);
      const val = this.elementHeights[m][1];
      if (val < h) {
        l = m + 1;
      } else if (val > h) {
        r = m - 1;
      } else {
        return m;
      }
    }
    return r;
  }
}

/*class TwoWayMap<T, U> {
  private map = new Map<T, U>();
  private revMap = new Map<U, T>();

  set(key: T, value: U) {
    if (this.map.has(key)) {
      console.log("KEY " + key + " IS ALREADY IN MAP");
    }
    this.map.set(key, value);
    this.revMap.set(value, key);
  }

  get(key: T) {
    return this.map.get(key);
  }

  revGet(value: U) {
    return this.revMap.get(value);
  }

  delete(key: T) {
    const value = this.get(key);
    const wasIn = this.map.delete(key);
    if (wasIn) {
      this.revMap.delete(value!);
    }
  }

  forEach(func: (value: U, key: T, map: Map<T, U>) => void) {
    this.map.forEach(func);
  }

  getMap() {
    return this.map;
  }
}*/