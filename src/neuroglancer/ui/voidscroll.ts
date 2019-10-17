import ResizeObserver from 'resize-observer-polyfill';

export class VoidScroll {
  private scrollArea: HTMLElement;
  private scrollbar: HTMLElement;
  private scrollbarFiller: HTMLElement;
  private sizeParent: HTMLElement;
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
      this.scrollbar.scrollBy({
        top: event.deltaY,
        behavior: 'auto'
      });
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

            const element = <HTMLElement>entry.target;
            const i = this.elementIndices.get(element)!;
            const nextHeight = (i + 1 === this.elementHeights.length) ?
                this.totalH :
                this.elementHeights[i + 1][1];
            const oldHeight = nextHeight - this.elementHeights[i][1];
            const newHeight = element.offsetHeight;
            const delta = newHeight - oldHeight;
            if (delta === 0 ||
                element.classList.contains('neuroglancer-annotation-hiding-list-hiddenitem')) {
              // Don't worry about elements that didn't change vertical size, or changed vertical
              // size because they were hidden
              continue;
            }

            this.shiftHeightsAfter(i + 1, delta);

            this.totalH += delta;
          }
          this.updateScrollHeight();
          this.updateScrollAreaPos();
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
    // shift indices of elements that came after the removed one
    for (const [el, ind] of this.elementIndices) {
      if (this.elementHeights[ind][1] > i) {
        this.elementIndices.set(el, ind - 1);
      }
    }

    this.totalH -= h;
    this.scrollArea.removeChild(element);
    this.updateScrollHeight();
    this.updateScrollAreaPos();
  }

  removeAll() {
    for (const [element] of this.elementIndices) {
      this.scrollArea.removeChild(element);
    }

    this.elementHeights = [];
    this.elementIndices = new Map<HTMLElement, number>();

    this.totalH = 0;
    this.loadedElements = [];
  }

  scrollTo(element: HTMLElement) {
    const h = this.elementHeights[this.elementIndices.get(element)!][1];
    // Scrolls just a pixel too far, this makes it look prettier
    this.scrollbar.scrollTop = h - 1;
    this.updateScrollAreaPos();
  }

  recalculateHeights() {
    this.totalH = 0;
    for (const [element, i] of this.elementIndices) {
      const h = element.offsetHeight;
      this.elementHeights[i][1] = this.totalH;
      this.totalH += h;
    }
    this.updateScrollHeight();
    this.updateScrollAreaPos();
  }

  private updateScrollHeight() {
    // Add some extra padding on the bottom
    this.scrollbarFiller.style.height = (this.totalH + 10) + 'px';
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