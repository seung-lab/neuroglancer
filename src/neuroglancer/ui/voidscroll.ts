import ResizeObserver from 'resize-observer-polyfill';

export class VoidScroll {
  private scrollArea: HTMLElement;
  private scrollbar: HTMLElement;
  private scrollbarFiller: HTMLElement;
  private sizeParent: HTMLElement;
  private heights: number[] = [];
  private heightMap = new Map<number, HTMLElement>();
  private totalH = 0;
  private loadedElements: HTMLElement[] = [];

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

    const resizeObserver = new ResizeObserver(this.updateScrollAreaPos.bind(this));
    resizeObserver.observe(this.sizeParent);
  }

  private updateScrollAreaPos() {
    for (const e of this.loadedElements) {
      e.style.display = 'none';
    }
    this.loadedElements = [];

    const h = this.scrollbar.scrollTop;
    const startI = this.findHeight(h);
    const endI = this.findHeight(h + this.sizeParent.offsetHeight);
    for (var i = startI; i <= endI; i++) {
      const element = this.heightMap.get(this.heights[i]);
      if (element) {
        element.style.removeProperty('display');
        this.loadedElements.push(element);
      }
    }
    const startH = this.heights[startI];
    const offset = startH - h;
    this.scrollArea.style.top = offset + 'px';
    this.scrollArea.style.right = (this.scrollbar.offsetWidth - this.scrollbar.clientWidth) + 'px';
    this.scrollArea.style.left = '0px';
  }

  private addElementHelper(element: HTMLElement) {
    this.scrollArea.appendChild(element);
    const h = element.offsetHeight;
    this.insertHeight(this.totalH);
    this.heightMap.set(this.totalH, element);
    this.totalH += h;
    element.style.display = 'none';
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
    element.style.removeProperty('display');
    const h = element.offsetHeight;

    for (var i = 0; i < this.heights.length; i++) {
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
    }

    this.totalH -= h;
    this.scrollArea.removeChild(element);
    this.updateScrollHeight();
    this.updateScrollAreaPos();
  }

  removeAll() {
    this.heightMap.forEach((element: HTMLElement) => {
      this.scrollArea.removeChild(element);
    });

    this.heights = [];
    this.heightMap = new Map<number, HTMLElement>();
    this.totalH = 0;
    this.loadedElements = [];
  }

  scrollTo(element: HTMLElement) {
    let h = 0;
    for (const [hKey, elem] of this.heightMap) {
      if (elem === element) {
        h = hKey;
        break;
      }
    }
    // Scrolls just a pixel too far, this makes it look prettier
    this.scrollbar.scrollTop = h - 1;
    this.updateScrollAreaPos();
  }

  private updateScrollHeight() {
    this.scrollbarFiller.style.height = this.totalH + 'px';
  }

  private insertHeight(h: number) {
    // find the equal or lowest height in the array, and insert it after that
    const i = this.findHeight(h) + 1;
    this.heights.splice(i, 0, h);
  }

  private findHeight(h: number) {
    // find the position in the heights array of the equal or lower height
    var l = 0;
    var r = this.heights.length;
    while (l <= r) {
      var m = Math.floor((l + r) / 2);
      if (this.heights[m] < h) {
        l = m + 1;
      } else if (this.heights[m] > h) {
        r = m - 1;
      } else {
        return m;
      }
    }
    return r;
  }
}