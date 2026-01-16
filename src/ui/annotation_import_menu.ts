import "#src/ui/annotation_import_menu.css";
import type { Annotation, AnnotationSource } from "#src/annotation/index.js";
import {
  AnnotationType,
  annotationTypeHandlers,
  annotationTypes,
  restoreAnnotation,
} from "#src/annotation/index.js";
import type { AnnotationUserLayer } from "#src/layer/annotation/index.js";
import { getLoadState } from "#src/layer/multi_channel_setup.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import {
  makeDerivedWatchableValue,
  WatchableValue,
} from "#src/trackable_value.js";
import { ModalDialog } from "#src/ui/modal_dialog.js";
import { WatchableMap } from "#src/util/watchable_map.js";

const optionalProperties = ["id", "description", "index"]; //, "relatedSegments"]; //, "type", "properties"];

export class AnnotationImportDialog extends ModalDialog {
  columnsContainer: HTMLElement;
  importAnnotationsButton: HTMLButtonElement;

  metadata: WatchableValueInterface<any> = new WatchableValue<any>(undefined);

  rows: WatchableValueInterface<string[][]> = new WatchableValue<string[][]>(
    [],
  );
  header: WatchableValueInterface<string[]> = this.registerDisposer(
    makeDerivedWatchableValue((rows) => {
      if (rows.length === 0) {
        return [];
      }
      return rows[0];
    }, this.rows),
  );
  isHeader: WatchableValueInterface<boolean> = new WatchableValue<boolean>(
    true,
  );
  dataRows: WatchableValueInterface<string[][]> = this.registerDisposer(
    makeDerivedWatchableValue(
      (rows, isHeader) => {
        if (rows.length === 0) {
          return [];
        }
        return rows.slice(isHeader ? 1 : 0);
      },
      this.rows,
      this.isHeader,
    ),
  );
  type: WatchableValueInterface<AnnotationType> =
    new WatchableValue<AnnotationType>(AnnotationType.POINT);
  sourceRank: WatchableValueInterface<number | undefined> = new WatchableValue<
    number | undefined
  >(undefined);

  columnMapping = this.registerDisposer(
    new WatchableMap<string, string[]>(() => {}),
  );

  pendingMap = new WatchableValue<string[] | undefined>(undefined);

  derivedProperties: WatchableValueInterface<
    {
      property: string;
      fullName: string;
      array: boolean;
      dimension?: number;
      optional?: boolean;
    }[]
  >;

  importable: WatchableValueInterface<boolean>;

  clearExisting: WatchableValueInterface<boolean> = new WatchableValue<boolean>(
    false,
  );

  constructor(private layer: AnnotationUserLayer) {
    super("Import Annotations");
    this.initializeAnnotationUI();
    console.log("create annotation import dialog", this.columnsContainer);
    this.layer.loadFromCSV;

    this.registerDisposer(
      this.columnMapping.changed.add(() => this.updateUI()),
    );
    this.registerDisposer(this.pendingMap.changed.add(() => this.updateUI()));
    this.registerDisposer(this.type.changed.add(() => this.updateUI()));
    this.registerDisposer(this.rows.changed.add(() => this.updateUI()));
    this.registerDisposer(this.sourceRank.changed.add(() => this.updateUI()));
    this.registerDisposer(this.isHeader.changed.add(() => this.updateUI()));
    this.registerDisposer(
      this.clearExisting.changed.add(() => this.updateUI()),
    );
    this.registerDisposer(this.metadata.changed.add(() => this.updateUI()));

    this.derivedProperties = this.registerDisposer(
      makeDerivedWatchableValue(
        (type, sourceRank) => {
          const { spatialProperties } = annotationTypeHandlers[type];
          const res = [
            ...spatialProperties
              .map(({ property, array }) => {
                return Array(sourceRank)
                  .fill(property)
                  .map((p, i) => {
                    return {
                      property: p,
                      fullName: `${p}[${i}]`,
                      dimension: i,
                      array: array || false,
                    };
                  });
              })
              .flat(),
            ...optionalProperties.map((p) => {
              return { property: p, fullName: p, optional: true, array: false };
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
      console.log("automateMapping called");
      const {
        header: { value: header },
        derivedProperties: { value: derivedProperties },
      } = this;
      for (const {
        property,
        fullName,
        array,
        dimension,
      } of derivedProperties) {
        if (array) {
          const matchingColumns = header.filter((h) =>
            h.match(`${property}\\[\\d+\\]\\[${dimension}\\]`),
          );
          this.columnMapping.set(fullName, matchingColumns);
        } else {
          if (header.includes(fullName)) {
            this.columnMapping.set(fullName, [fullName]); // TODO, this ends up triggering updateUI multiple times
          }
        }
      }
    };
    this.registerDisposer(this.derivedProperties.changed.add(automatedMapping));
    this.registerDisposer(
      this.header.changed.add(() => {
        const inferredType = this.inferTypeFromHeader(this.header.value);
        if (inferredType) {
          this.type.value = inferredType;
        }
        automatedMapping();
      }),
    );
    // automatedMapping();

    this.importable = this.registerDisposer(
      makeDerivedWatchableValue(
        (derivedProperties, columnMapping) => {
          return derivedProperties.every(
            (prop) => prop.optional || columnMapping.has(prop.fullName),
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
      header: { value: header },
      dataRows: { value: dataRows },
      clearExisting: { value: clearExisting },
    } = this;

    if (!sourceRank) {
      throw new Error("Cannot import annotations, source rank unknown");
    }

    if (!importable) {
      throw new Error(
        "Cannot import annotations, required properties not mapped",
      );
    }

    if (dataRows.length === 0) {
      throw new Error("Cannot import annotations, no data rows available");
    }

    const { spatialProperties } = annotationTypeHandlers[type];

    const propertyToColumnIndex: Map<string, number[]> = new Map();
    for (const [property, columns] of this.columnMapping) {
      propertyToColumnIndex.set(
        property,
        columns.map((column) => header.findIndex((h) => h === column)),
      );
    }

    console.log("propertyToColumnIndex", propertyToColumnIndex);

    console.log("spatialProperties", spatialProperties);

    const parseAnnotation = (row: string[]) => {
      const annotationData: any = {
        type: AnnotationType[type],
        // id: 1,
        // description: "",
        // relatedSegments: [],
      };
      for (const { property, array } of spatialProperties) {
        if (array) {
          // const columnIndices = propertyToColumnIndex.get(property)!;

          // for (let i = 0; i < columnIndices.length; i++) {
          // }

          // columnIndices.map((index => {
          //   const vec = Array(sourceRank).map((_, i) => row[index + i];

          // })

          const vec = Array(sourceRank)
            .fill(undefined)
            .map((_, i) =>
              propertyToColumnIndex
                .get(`${property}[${i}]`)!
                .map((index) => row[index]),
            );

          const length = vec[0].length; // TODO cleanup;

          // need to invert the array
          const data = Array(length)
            .fill(undefined)
            .map((_, i) => {
              return Array(sourceRank)
                .fill(undefined)
                .map((_, j) => vec[j][i]);
            });

          annotationData[property] = data;
        } else {
          const data = Array(sourceRank)
            .fill(undefined)
            .map(
              (_, i) => row[propertyToColumnIndex.get(`${property}[${i}]`)![0]],
            );
          annotationData[property] = data;
        }
      }
      for (const optionalProperty of optionalProperties) {
        if (propertyToColumnIndex.has(optionalProperty)) {
          annotationData[optionalProperty] =
            row[propertyToColumnIndex.get(optionalProperty)![0]];
        }
      }
      return annotationData satisfies Annotation;
    };

    const annotationSource: AnnotationSource | undefined =
      this.layer.localAnnotations;

    if (!annotationSource) {
      throw new Error("No local annotation source available on layer");
    }

    if (clearExisting) {
      annotationSource.clear();
    }

    for (const row of dataRows) {
      const parsedAnnotation = parseAnnotation(row);
      const restored = restoreAnnotation(
        parsedAnnotation,
        annotationSource,
        false,
      );
      if (annotationSource.get(restored.id)) {
        annotationSource.update(
          annotationSource.getReference(restored.id),
          restored,
        );
      } else {
        annotationSource.add(restored);
      }
    }

    this.close();
  }

  initializeAnnotationUI() {
    const step1 = document.createElement("div");
    step1.textContent = `Select a csv file containing annotations and optionally a metadata file (in NG format)`;
    this.mainBody.appendChild(step1);

    const importButton = document.createElement("input");
    importButton.type = "file";
    importButton.multiple = true;
    importButton.accept = ".csv,.json,application/json,text/csv";
    importButton.title = "Import annotation state from a CSV file";
    this.mainBody.appendChild(importButton);
    importButton.addEventListener("change", async () => {
      // reset state
      this.metadata.value = undefined;
      this.rows.value = [];

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
      const metadata = contentByType.get("application/json") ?? [];
      if (metadata.length > 1) {
        throw new Error("Multiple metadata files provided");
      }
      if (metadata.length === 1) {
        this.metadata.value = JSON.parse(metadata[0]);
      }
      const csvs = contentByType.get("text/csv") ?? [];
      if (csvs.length > 0) {
        const firstFile = csvs[0];
        this.rows.value = firstFile.split("\n").map((row) => row.split(","));
      }
    });

    const step2 = document.createElement("div");
    step2.textContent = `Change the annotation type if necessary`;
    this.mainBody.appendChild(step2);

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
        console.log("annotation type changed", this.type.value);
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

    const step3 = document.createElement("div");
    step3.textContent = `Click on input column and then output property to map from csv to neuroglancer format`;
    this.mainBody.appendChild(step3);

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

    const isHeaderLabel = document.createElement("label");
    isHeaderLabel.textContent = "First row is header";
    const isHeaderCheckbox = document.createElement("input");
    isHeaderCheckbox.type = "checkbox";
    isHeaderCheckbox.checked = this.isHeader.value;
    isHeaderLabel.appendChild(isHeaderCheckbox);
    footerScreenshotActionBtnsContainer.appendChild(isHeaderLabel);
    isHeaderCheckbox.addEventListener("change", () => {
      this.isHeader.value = isHeaderCheckbox.checked;
    });

    const clearExistingLabel = document.createElement("label");
    clearExistingLabel.textContent = "Clear existing";
    const clearExistingCheckbox = document.createElement("input");
    clearExistingCheckbox.type = "checkbox";
    clearExistingCheckbox.checked = this.clearExisting.value;
    clearExistingLabel.appendChild(clearExistingCheckbox);
    footerScreenshotActionBtnsContainer.appendChild(clearExistingLabel);
    clearExistingCheckbox.addEventListener("change", () => {
      this.clearExisting.value = clearExistingCheckbox.checked;
    });

    footerScreenshotActionBtnsContainer.appendChild(
      this.importAnnotationsButton,
    );

    this.content.appendChild(footerScreenshotActionBtnsContainer);
  }

  inferTypeFromHeader(header: string[]): AnnotationType | null {
    const headersWithArraysJoined = this.joinArrayHeaders(header);
    for (const [type, handler] of Object.entries(annotationTypeHandlers)) {
      const { spatialProperties } = handler;
      let allPropertiesPresent = true;
      for (const { property, array } of spatialProperties) {
        if (
          array &&
          headersWithArraysJoined.keys().find((x) => x.startsWith(property))
        ) {
          continue; // we found an earray entry, TODO this is quick hack
        }

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
      dataRows: { value: dataRows },
      sourceRank: { value: sourceRank },
      columnMapping: { value: columnMapping },
      derivedProperties: { value: derivedProperties },
      importable: { value: importable },
      metadata: { value: metadata },
    } = this;
    if (this.columnsContainer.firstChild) {
      this.columnsContainer.removeChild(this.columnsContainer.firstChild);
    }

    if (!sourceRank) return; // TEMP

    const resultContainer = document.createElement("div");
    this.columnsContainer.appendChild(resultContainer);

    if (metadata) {
      const metadataHeader = document.createElement("h4");
      metadataHeader.textContent = "Metadata";
      resultContainer.appendChild(metadataHeader);
      const metadataPre = document.createElement("pre");
      metadataPre.classList.add("annotation-import-metadata-display");
      metadataPre.textContent = JSON.stringify(metadata, null, 2);
      resultContainer.appendChild(metadataPre);
    }

    const rankInfo = document.createElement("div");
    rankInfo.textContent = `Source rank: ${sourceRank !== undefined ? sourceRank : "N/A"}`;
    resultContainer.appendChild(rankInfo);

    const rowCountInfo = document.createElement("div");
    rowCountInfo.textContent = `Annotations: ${dataRows.length}`;
    resultContainer.appendChild(rowCountInfo);

    const columnsHeader = document.createElement("h4");
    columnsHeader.textContent = "Column Mapping";
    resultContainer.appendChild(columnsHeader);

    const mappedColumns = new Set([...columnMapping.values()].flat());

    const sortedColumns = Array.from(header).sort((a, b) => {
      const aMapped = mappedColumns.has(a);
      const bMapped = mappedColumns.has(b);
      if (aMapped && !bMapped) return 1;
      if (!aMapped && bMapped) return -1;
      return 1;
    });

    const availableColumns = document.createElement("div");
    availableColumns.classList.add("annotation-import-available-columns");
    for (const column of sortedColumns) {
      const columnEl = document.createElement("div");
      columnEl.textContent = column;
      availableColumns.appendChild(columnEl);
      columnEl.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        if (evt.shiftKey) {
          const currentPending = this.pendingMap.value || [];
          if (currentPending.includes(column)) {
            this.pendingMap.value = currentPending.filter((c) => c !== column);
          } else {
            this.pendingMap.value = [...currentPending, column];
          }
        } else {
          this.pendingMap.value = [column];
        }
      });
      if (this.pendingMap.value && this.pendingMap.value.includes(column)) {
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

    for (const { property, fullName, optional, array } of derivedProperties) {
      const fieldContainer = document.createElement("div");
      fieldContainer.classList.add("annotation-import-field");

      annotationFields.appendChild(fieldContainer);

      if (columnMapping.has(fullName)) {
        // select.value = columnMapping.get(propertyId)!;
        fieldContainer.classList.add("annotation-import-field-mapped");
        const mappedColumn = document.createElement("div");
        mappedColumn.classList.add("annotation-import-field-mapped-column");
        mappedColumn.textContent = `${columnMapping.get(fullName)}`;
        fieldContainer.appendChild(mappedColumn);

        const importFieldLink = document.createElement("div");
        importFieldLink.classList.add("annotation-import-field-link");
        fieldContainer.appendChild(importFieldLink);

        // add unset button
        const unsetButton = document.createElement("button");
        unsetButton.textContent = "Unset";
        unsetButton.classList.add("annotation-import-unset-button");
        unsetButton.addEventListener("click", () => {
          // e.stopPropagation();
          this.columnMapping.delete(fullName);
        });
        importFieldLink.appendChild(unsetButton);
      } else if (!optional) {
        fieldContainer.classList.add("annotation-import-field-missing");
      }

      const propertyName = document.createElement("div");
      propertyName.classList.add("annotation-import-field-property-name");
      propertyName.textContent = fullName;
      fieldContainer.appendChild(propertyName);

      propertyName.addEventListener("click", () => {
        if (this.pendingMap.value) {
          this.columnMapping.set(fullName, this.pendingMap.value);
          this.pendingMap.value = undefined;
        }
      });

      if (array) {
        const arrayInfo = document.createElement("div");
        arrayInfo.classList.add("annotation-import-field-array-info");
        arrayInfo.textContent = `Append To Array`;
        fieldContainer.appendChild(arrayInfo);

        arrayInfo.addEventListener("click", () => {
          if (this.pendingMap.value) {
            this.columnMapping.set(property, [
              ...(this.columnMapping.get(property) || []),
              ...this.pendingMap.value,
            ]);
            this.pendingMap.value = undefined;
          }
        });
      }
    }

    resultContainer.appendChild(annotationFields);

    this.importAnnotationsButton.disabled = !importable;
  }
}
