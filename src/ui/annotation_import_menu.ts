import "#src/ui/annotation_import_menu.css";
import {
  AnnotationType,
  annotationTypeHandlers,
  annotationTypes,
} from "#src/annotation/index.js";
import { AnnotationUserLayer } from "#src/layer/annotation/index.js";
import {
  WatchableValue,
  WatchableValueInterface,
} from "#src/trackable_value.js";
import { ModalDialog } from "#src/ui/modal_dialog.js";

export class AnnotationImportDialog extends ModalDialog {
  columnsContainer: HTMLElement;
  importAnnotationsButton: HTMLButtonElement;

  header: WatchableValueInterface<string[]> = new WatchableValue<string[]>([]);
  rowCount: WatchableValueInterface<number> = new WatchableValue<number>(0);
  type: WatchableValueInterface<AnnotationType> =
    new WatchableValue<AnnotationType>(AnnotationType.POINT);

  constructor(private layer: AnnotationUserLayer) {
    super("Import Annotations");
    this.initializeAnnotationUI();
    console.log("create annotation import dialog", this.columnsContainer);
    this.layer.loadFromCSV;

    this.registerDisposer(this.header.changed.add(() => this.updateUI()));
    this.registerDisposer(this.type.changed.add(() => this.updateUI()));
    this.registerDisposer(this.rowCount.changed.add(() => this.updateUI()));
  }

  importAnnotations() {
    console.log("importAnnotations called");
  }

  initializeAnnotationUI() {
    const description = document.createElement("div");
    description.textContent = `Import annotation state from a CSV file and associated metadata.

Annotations must be in the following format CSV format:


TODO lets simplyify this now and import one type at a time, and require a header

      `;

    this.mainBody.appendChild(description);

    const importButton = document.createElement("input");
    importButton.type = "file";
    // importButton.multiple = true;
    importButton.accept = ".csv,.json,application/json,text/csv";
    importButton.title = "Import annotation state from a CSV file";
    this.mainBody.appendChild(importButton);
    importButton.addEventListener("change", async () => {
      const files = importButton.files;
      if (!files) return;
      const processedFiles = await Promise.all(
        Array.from(files).map((f) => {
          return new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
              const result = e.target?.result;
              if (typeof result !== "string") {
                reject(new Error("FileReader result is not a string"));
                return;
              }
              resolve(result);
            };
            reader.onerror = (e) => {
              reject(e);
            };
            reader.readAsText(f);
          });
        }),
      );
      const contentByType = new Map<string, string[]>();
      for (const [index, content] of processedFiles.entries()) {
        const file = files[index];
        contentByType.set(
          file.type,
          (contentByType.get(file.type) ?? []).concat([content]),
        );
      }
      //   const metadata = contentByType.get("application/json") ?? [];
      //   if (metadata.length > 1) {
      //     throw new Error("Multiple metadata files provided");
      //   }
      //   if (metadata.length === 0) {
      //     throw new Error("No metadata file provided");
      //   }
      const csvs = contentByType.get("text/csv") ?? [];

      if (csvs.length === 0) {
      } else {
        const first = csvs[0];
        const header = first.split("\n")[0].split(',');
        const inferredType = this.inferTypeFromHeader(header);
        if (inferredType) {
            this.type.value = inferredType;
        }
        this.header.value = header
        this.rowCount.value = first.split("\n").length - 1;
      }

      //   this.layer.loadFromCSV(JSON.parse(metadata[0]), csvs);
    });

    const columnsHeader = document.createElement("h3");
    columnsHeader.textContent = "Column Mapping";
    this.mainBody.appendChild(columnsHeader);

    const annotationType = document.createElement("select");
    for (const type of annotationTypes) {
      const option = document.createElement("option");
      option.value = AnnotationType[type];
      option.textContent = AnnotationType[type];
      annotationType.appendChild(option);
    }
    this.mainBody.appendChild(annotationType);
    annotationType.addEventListener("change", () => {
      const value = annotationType.value as keyof typeof AnnotationType;
      this.type.value = AnnotationType[value];
    });
    this.registerDisposer(this.type.changed.add(() => {
      annotationType.value = AnnotationType[this.type.value];
    }));

    this.columnsContainer = document.createElement("div");
    this.mainBody.appendChild(this.columnsContainer);

    this.importAnnotationsButton = this.createButton(
      "Import annotations",
      () => this.importAnnotations(),
      "neuroglancer-modal-dialog-footer-button",
    );

    const footerScreenshotActionBtnsContainer = document.createElement("div");
    footerScreenshotActionBtnsContainer.classList.add(
      "neuroglancer-modal-dialog-footer-container",
    );

    footerScreenshotActionBtnsContainer.appendChild(
      this.importAnnotationsButton,
    );

    this.content.appendChild(footerScreenshotActionBtnsContainer);
  }

  inferTypeFromHeader(header: string[]): AnnotationType | null {
    const headersWithArraysJoined = this.joinArrayHeaders(header);
    for (const [type, handler] of Object.entries(annotationTypeHandlers)) {
      const { dataProperties } = handler;
      let allPropertiesPresent = true;
      for (const property of dataProperties) {
        if (!headersWithArraysJoined.has(property)) {
          allPropertiesPresent = false;
          break;
        }
      }
      if (allPropertiesPresent) {
        return type as unknown as AnnotationType;
      }
    }
    return null;
  }

  joinArrayHeaders(header: string[]): Map<string, number[] | number> {
    const headersWithArraysJoined = new Map<string, number[] | number>();
    for (const [idx, col] of header.entries()) {
      if (col.endsWith("]")) {
        const baseName = col.split("[")[0];
        const index = col.match(/\[(\d+)\]/)![1];

        const current = headersWithArraysJoined.get(baseName) ?? [];
        if (Array.isArray(current)) {
          current[Number(index)] = idx;
          headersWithArraysJoined.set(baseName, current);
        } else {
          throw new Error("Inconsistent array indices in header");
        }
      } else {
        headersWithArraysJoined.set(col, idx);
      }
    }
    return headersWithArraysJoined;
}

  updateUI() {
    console.log("updating UI", this.columnsContainer);
    const {
      header: { value: header },
      type: { value: type },
      rowCount: { value: rowCount}
    } = this;
    if (this.columnsContainer.firstChild) {
      this.columnsContainer.removeChild(this.columnsContainer.firstChild);
    }

    const resultContainer = document.createElement("div");
    this.columnsContainer.appendChild(resultContainer);

    const rowCountInfo = document.createElement("div");
    rowCountInfo.textContent = `Rows detected: ${rowCount}`;
    resultContainer.appendChild(rowCountInfo);

    const availableColumnsInfo = document.createElement("div");
    availableColumnsInfo.textContent = `Available columns: ${header.join(
      ", ",
    )}`;
    resultContainer.appendChild(availableColumnsInfo);

    const headersWithArraysJoined = this.joinArrayHeaders(header);

    console.log("headersWithArraysJoined", headersWithArraysJoined);

    const { dataProperties } = annotationTypeHandlers[type];

    const optionalProperties = ["id", "description", "relatedSegments"];

    const allAnnotationProperties = [...dataProperties, ...optionalProperties];

    const columns = document.createElement("div");
    columns.classList.add("annotation-import-columns-container");
    // for column of annotation type, create a select element to choose the column

    for (const property of allAnnotationProperties) {
    //   const propertyContainer = document.createElement("div");
      const label = document.createElement("label");
      label.textContent = property;
    //   propertyContainer.appendChild(label);

      const select = document.createElement("select");
    
      if (optionalProperties.includes(property)) {
        const noneOption = document.createElement("option");
        noneOption.value = "";
        noneOption.textContent = "None";
        select.appendChild(noneOption);
      }

      for (const [col, idx] of headersWithArraysJoined.entries()) {
        const option = document.createElement("option");
        const myValue = Array.isArray(idx) ? `${col}[${idx.length}]` : col;
        option.value = myValue;
        option.textContent = myValue;
        select.appendChild(option);

        if (property === col) {
          select.value = myValue;
        }
      }

      columns.appendChild(label);
      columns.appendChild(select);
    //   propertyContainer.appendChild(select);
    //   columns.appendChild(propertyContainer);
    }

    resultContainer.appendChild(columns);
  }
}
