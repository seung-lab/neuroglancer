import "#src/ui/annotation_import_menu.css";
import {
  Annotation,
  AnnotationSource,
  AnnotationType,
  annotationTypeHandlers,
  annotationTypes,
  Line,
  Point,
  restoreAnnotation,
} from "#src/annotation/index.js";
import { AnnotationUserLayer } from "#src/layer/annotation/index.js";
import {
  makeDerivedWatchableValue,
  WatchableValue,
  WatchableValueInterface,
} from "#src/trackable_value.js";
import { ModalDialog } from "#src/ui/modal_dialog.js";
import { getLoadState } from "#src/layer/multi_channel_setup.js";
import { WatchableMap } from "#src/util/watchable_map.js";

const optionalProperties = ["id", "description", "relatedSegments"]; //, "type", "properties"];

export class AnnotationImportDialog extends ModalDialog {
  columnsContainer: HTMLElement;
  importAnnotationsButton: HTMLButtonElement;

  header: WatchableValueInterface<string[]> = new WatchableValue<string[]>([]);
  //rowCount: WatchableValueInterface<number> = new WatchableValue<number>(0);
  rows: WatchableValueInterface<string[][]> = new WatchableValue<string[][]>(
    [],
  );
  type: WatchableValueInterface<AnnotationType> =
    new WatchableValue<AnnotationType>(AnnotationType.POINT);
  sourceRank: WatchableValueInterface<number | undefined> = new WatchableValue<
    number | undefined
  >(undefined);

  columnMapping = this.registerDisposer(
    new WatchableMap<string, string>(() => {}),
  );

  pendingMap = new WatchableValue<string | undefined>(undefined);

  derivedProperties: WatchableValueInterface<
    {
      property: string;
      optional?: boolean;
    }[]
  >;

  importable: WatchableValueInterface<boolean>;

  constructor(private layer: AnnotationUserLayer) {
    super("Import Annotations");
    this.initializeAnnotationUI();
    console.log("create annotation import dialog", this.columnsContainer);
    this.layer.loadFromCSV;

    this.registerDisposer(
      this.columnMapping.changed.add(() => this.updateUI()),
    );
    this.registerDisposer(this.pendingMap.changed.add(() => this.updateUI()));
    // this.registerDisposer(this.header.changed.add(() => this.updateUI()));
    this.registerDisposer(this.type.changed.add(() => this.updateUI()));
    this.registerDisposer(this.rows.changed.add(() => this.updateUI()));
    this.registerDisposer(this.sourceRank.changed.add(() => this.updateUI()));

    // type X = keyof (Line | Point);

    // type SameKeysAsSource<NewType> = {
    //   [Key in keyof Annotation]: NewType;
    // };

    // const myMap: SameKeysAsSource<string|string[]> = {
    //   id: "id",
    //   description: "description",
    //   relatedSegments: "relatedSegments",
    //   type: "type",
    //   properties: "properties",
    //   pointA: "bh"
    // }

    this.derivedProperties = this.registerDisposer(
      makeDerivedWatchableValue(
        (type, sourceRank) => {
          const { dataProperties } = annotationTypeHandlers[type];
          const res = [
            ...dataProperties
              .map((property) => {
                return Array(sourceRank)
                  .fill(property)
                  .map((p, i) => {
                    return { property: `${p}[${i}]` };
                  });
              })
              .flat(),
            ...optionalProperties.map((p) => {
              return { property: p, optional: true };
            }),
          ];
          return res;
        },
        this.type,
        this.sourceRank,
      ),
    );
    this.registerDisposer(
      this.derivedProperties.changed.add(() => this.updateUI()),
    );

    const automatedMapping = () => {
      const {
        header: { value: header },
        derivedProperties: { value: derivedProperties },
      } = this;
      for (const { property } of derivedProperties) {
        if (header.includes(property)) {
          this.columnMapping.set(property, property); // TODO, this ends up triggering updateUI multiple times
        }
      }
    };
    this.registerDisposer(this.derivedProperties.changed.add(automatedMapping));
    this.registerDisposer(this.header.changed.add(automatedMapping));
    // automatedMapping();

    this.importable = this.registerDisposer(
      makeDerivedWatchableValue(
        (derivedProperties, columnMapping) => {
          return derivedProperties.every(
            (prop) => prop.optional || columnMapping.has(prop.property),
          );
        },
        this.derivedProperties,
        this.columnMapping,
      ),
    );

    this.registerDisposer(this.importable.changed.add(() => this.updateUI()));

    const updateSourceRank = () => {
      const loadState = getLoadState(this.layer.managedLayer);
      if (loadState && loadState.error === undefined) {
        this.sourceRank.value = loadState.transform.value.sourceRank;
      } else {
        this.sourceRank.value = undefined;
      }
    };
    this.registerDisposer(this.layer.dataSourcesChanged.add(updateSourceRank));
    updateSourceRank();
  }

  importAnnotations() {
    const {
      importable: { value: importable },
      type: { value: type },
      sourceRank: { value: sourceRank },
      rows: { value: rows },
    } = this;

    if (!sourceRank) {
      throw new Error("Cannot import annotations, source rank unknown");
    }

    if (!importable) {
      throw new Error(
        "Cannot import annotations, required properties not mapped",
      );
    }

    console.log("this.columnMapping", this.columnMapping);

    // this.layer.importFromCSVMapping(this.header.value, this.columnMapping);

    // const {type: { value: type }} = this;

    // const {
    //   derivedProperties: { value: derivedProperties },
    // } = this;

    const { dataProperties } = annotationTypeHandlers[type];

    const header = this.header.value;

    const propertyToColumnIndex: Map<string, number> = new Map();
    for (const [property, column] of this.columnMapping) {
      propertyToColumnIndex.set(
        property,
        header.findIndex((h) => h === column),
      );
    }

    const parseAnnotation = (row: string[]) => {
      const annotationData: any = {
        type: AnnotationType[type],
        // id: 1,
        // description: "",
        // relatedSegments: [],
      };
      for (const property of dataProperties) {
        const data = Array(sourceRank)
          .fill(undefined)
          .map((_, i) => row[propertyToColumnIndex.get(`${property}[${i}]`)!]);
        annotationData[property] = data;
      }
      for (const optionalProperty of optionalProperties) {
        if (propertyToColumnIndex.has(optionalProperty)) {
          annotationData[optionalProperty] =
            row[propertyToColumnIndex.get(optionalProperty)!];
        }
      }
      return annotationData satisfies Annotation;
    };

    const test = parseAnnotation(rows[0]);

    const annotationSource: AnnotationSource|undefined = this.layer.localAnnotations;

    console.log("test", test);

    if (annotationSource) {
      const restored = restoreAnnotation(
        test,
        annotationSource,
        false,
      );
      if (annotationSource.get(restored.id)) {
        annotationSource.update(annotationSource.getReference(restored.id), restored);
      } else {
        annotationSource.add(restored);
      }
    }

    // const testParsed = annotationTypeHandlers[type].restoreState(test);

    // // if

    // if (
    //   derivedProperties.every(
    //     (prop) => !prop.optional || this.columnMapping.has(prop.property),
    //   )
    // ) {
    //   console.log("All required properties mapped, proceeding with import");
    // }
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
        const firstFile = csvs[0];

        const rows = firstFile.split("\n").map((row) => row.split(","));

        const [header, ...rest] = rows;

        const inferredType = this.inferTypeFromHeader(header);
        if (inferredType) {
          this.type.value = inferredType;
        }
        this.header.value = header;
        this.rows.value = rest;
      }
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
    this.registerDisposer(
      this.type.changed.add(() => {
        annotationType.value = AnnotationType[this.type.value];
        this.columnMapping.clear();
        this.pendingMap.value = undefined;
      }),
    );
    this.registerDisposer(
      this.header.changed.add(() => {
        this.columnMapping.clear();
        this.pendingMap.value = undefined;
      }),
    );

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
    console.log("layer", this.layer.dataSources[0].loadState);

    const {
      header: { value: header },
      // type: { value: type },
      rows: { value: rows },
      sourceRank: { value: sourceRank },
      columnMapping: { value: columnMapping },
      derivedProperties: { value: derivedProperties },
      importable: { value: importable },
    } = this;
    if (this.columnsContainer.firstChild) {
      this.columnsContainer.removeChild(this.columnsContainer.firstChild);
    }

    if (!sourceRank) return; // TEMP

    const resultContainer = document.createElement("div");
    this.columnsContainer.appendChild(resultContainer);

    const rankInfo = document.createElement("div");
    rankInfo.textContent = `Source rank: ${sourceRank !== undefined ? sourceRank : "N/A"}`;
    resultContainer.appendChild(rankInfo);

    const rowCountInfo = document.createElement("div");
    rowCountInfo.textContent = `Rows detected: ${rows.length}`;
    resultContainer.appendChild(rowCountInfo);

    const mappedColumns = new Set(columnMapping.values());

    const sortedColumns = Array.from(header).sort((a, b) => {
      const aMapped = mappedColumns.has(a);
      const bMapped = mappedColumns.has(b);
      if (aMapped && !bMapped) return 1;
      if (!aMapped && bMapped) return -1;
      return -1;
    });

    const availableColumns = document.createElement("div");
    availableColumns.classList.add("annotation-import-available-columns");
    for (const column of sortedColumns) {
      const columnEl = document.createElement("div");
      columnEl.textContent = column;
      availableColumns.appendChild(columnEl);
      columnEl.addEventListener("click", () => {
        this.pendingMap.value = column;
      });
      if (this.pendingMap.value === column) {
        columnEl.classList.add("annotation-import-available-column-pending");
      }
      if (mappedColumns.has(column)) {
        columnEl.classList.add("annotation-import-available-column-mapped");
      }
    }
    resultContainer.appendChild(availableColumns);

    // const headersWithArraysJoined = this.joinArrayHeaders(header);

    // console.log("headersWithArraysJoined", headersWithArraysJoined);

    // const { dataProperties } = annotationTypeHandlers[type];

    // const allAnnotationProperties = [...dataProperties, ...optionalProperties];

    const annotationFields = document.createElement("div");
    annotationFields.classList.add("annotation-import-fields-container");

    for (const { property, optional } of derivedProperties) {
      const fieldContainer = document.createElement("div");
      fieldContainer.classList.add("annotation-import-field");

      const label = document.createElement("label");
      label.textContent = property;
      fieldContainer.appendChild(label);

      // const select = document.createElement("select");
      // const noneOption = document.createElement("option");
      // noneOption.value = "";
      // noneOption.textContent = "None";
      // select.appendChild(noneOption);

      // for (const column of header) {
      //   const option = document.createElement("option");
      //   option.value = column;
      //   option.textContent = column;
      //   select.appendChild(option);
      // }
      // fieldContainer.appendChild(select);
      annotationFields.appendChild(fieldContainer);

      if (columnMapping.has(property)) {
        // select.value = columnMapping.get(propertyId)!;
        fieldContainer.classList.add("annotation-import-field-mapped");
        const mappedColumn = document.createElement("div");
        mappedColumn.textContent = `<- ${columnMapping.get(property)}`;
        fieldContainer.appendChild(mappedColumn);
        // add unset button
        const unsetButton = document.createElement("button");
        unsetButton.textContent = "Unset";
        unsetButton.classList.add("annotation-import-unset-button");
        unsetButton.addEventListener("click", () => {
          // e.stopPropagation();
          this.columnMapping.delete(property);
        });
        fieldContainer.appendChild(unsetButton);
      } else if (!optional) {
        fieldContainer.classList.add("annotation-import-field-missing");
      }

      fieldContainer.addEventListener("click", () => {
        if (this.pendingMap.value) {
          this.columnMapping.set(property, this.pendingMap.value);
          this.pendingMap.value = undefined;
        }
      });
    }

    resultContainer.appendChild(annotationFields);

    this.importAnnotationsButton.disabled = !importable;

    // for column of annotation type, create a select element to choose the column

    // allAnnotationProperties;

    // for (const [col, idx] of headersWithArraysJoined.entries()) {
    //   idx;
    //   const propertyContainer = document.createElement("div");
    //   const label = document.createElement("label");
    //   label.textContent = col;
    //   propertyContainer.appendChild(label);
    //   columns.appendChild(propertyContainer);
    //   }
    // for (const property of allAnnotationProperties) {
    //   //   const propertyContainer = document.createElement("div");
    //   const label = document.createElement("label");
    //   label.textContent = property;
    //   //   propertyContainer.appendChild(label);

    //   const select = document.createElement("select");

    //   if (optionalProperties.includes(property)) {
    //     const noneOption = document.createElement("option");
    //     noneOption.value = "";
    //     noneOption.textContent = "None";
    //     select.appendChild(noneOption);
    //   }

    //   for (const [col, idx] of headersWithArraysJoined.entries()) {
    //     const option = document.createElement("option");
    //     const myValue = Array.isArray(idx) ? `${col}[${idx.length}]` : col;
    //     option.value = myValue;
    //     option.textContent = myValue;
    //     select.appendChild(option);

    //     if (property === col) {
    //       select.value = myValue;
    //     }
    //   }

    //   columns.appendChild(label);
    //   columns.appendChild(select);
    //   //   propertyContainer.appendChild(select);
    //   //   columns.appendChild(propertyContainer);
    // }

    // resultContainer.appendChild(columns);
  }
}
