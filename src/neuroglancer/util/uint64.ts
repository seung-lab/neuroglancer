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

const randomTempBuffer = new Uint32Array(2);

const trueBase = 0x100000000;

// For dealing with the string representation in base b, we will represent the 64-bit number as
//
//   highPrime * intermediateBase[b] + lowPrime,
//
// where:
//
//   intermediateBaseForBase[b] = Math.pow(b, lowDigitsforBase[b]),
//
// and
//
//   lowDigitsForBase[b] = Math.floor(Math.log(Math.pow(2,53 - 32)) / Math.log(b)).

interface StringConversionData {
  lowDigits: number;

  lowBase: number;

  // lowBase = lowBase1 * lowBase2.
  lowBase1: number;
  lowBase2: number;

  pattern: RegExp;
}

let stringConversionData: StringConversionData[] = [];
for (let base = 2; base <= 36; ++base) {
  let lowDigits = Math.floor(32 / Math.log2(base));
  let lowBase = Math.pow(base, lowDigits);
  let lowDigits1 = Math.floor(lowDigits / 2);
  let lowBase1 = Math.pow(base, lowDigits1);
  let lowBase2 = Math.pow(base, lowDigits - lowDigits1);
  let patternString = `^[0-${String.fromCharCode('0'.charCodeAt(0) + Math.min(9, base - 1))}`;
  if (base > 10) {
    patternString += `a-${String.fromCharCode('a'.charCodeAt(0) + base - 11)}`;
    patternString += `A-${String.fromCharCode('A'.charCodeAt(0) + base - 11)}`;
  }
  let maxDigits = Math.ceil(64 / Math.log2(base));
  patternString += `]{1,${maxDigits}}$`;
  let pattern = new RegExp(patternString);
  stringConversionData[base] = {lowDigits, lowBase, lowBase1, lowBase2, pattern};
}

export class Uint64 {
  constructor(public low: number = 0, public high: number = 0) {}

  clone() { return new Uint64(this.low, this.high); }

  assign(x: Uint64) {
    this.low = x.low;
    this.high = x.high;
  }

  toString(base = 10): string {
    let vLow = this.low, vHigh = this.high;
    if (vHigh === 0) {
      return vLow.toString(base);
    }
    vHigh *= trueBase;
    let {lowBase, lowDigits} = stringConversionData[base];
    let vHighExtra = vHigh % lowBase;
    vHigh = Math.floor(vHigh / lowBase);
    vLow += vHighExtra;
    vHigh += Math.floor(vLow / lowBase);
    vLow = vLow % lowBase;
    let vLowStr = vLow.toString(base);
    return vHigh.toString(base) + '0'.repeat(lowDigits - vLowStr.length) + vLowStr;
  }

  /**
   * Returns true if a is strictly less than b.
   */
  static less(a: Uint64, b: Uint64): boolean {
    return a.high < b.high || (a.high === b.high && a.low < b.low);
  }

  /**
   * Returns a negative number if a is strictly less than b, 0 if a is equal to b, or a positive
   * number if a is strictly greater than b.
   */
  static compare(a: Uint64, b: Uint64): number { return (a.high - b.high) || (a.low - b.low); }

  static ZERO = new Uint64(0, 0);

  static equal(a: Uint64, b: Uint64) { return a.low === b.low && a.high === b.high; }

  static min(...args: Uint64[]): Uint64 { 
    let minimum = args[0];

    for (let i = 1; i < args.length - 1; i++) {
      let contender = args[i];
      minimum = Uint64.less(minimum, contender) ? minimum : contender;
    }

    return minimum; 
  }

  static max(...args: Uint64[]): Uint64 { 
    let maximum = args[0];

    for (let i = 1; i < args.length - 1; i++) {
      let contender = args[i];
      maximum = Uint64.less(maximum, contender) ? contender : maximum;
    }

    return maximum; 
  }

  static random() {
    crypto.getRandomValues(randomTempBuffer);
    return new Uint64(randomTempBuffer[0], randomTempBuffer[1]);
  }

  tryParseString(s: string, base = 10) {
    let {lowDigits, lowBase, lowBase1, lowBase2, pattern} = stringConversionData[base];
    if (!pattern.test(s)) {
      return false;
    }
    if (s.length <= lowDigits) {
      this.low = parseInt(s, base);
      this.high = 0;
      return true;
    }
    let splitPoint = s.length - lowDigits;
    let lowPrime = parseInt(s.substr(splitPoint), base);
    let highPrime = parseInt(s.substr(0, splitPoint), base);

    let highConverted = highPrime * lowBase;

    let high = Math.floor(highConverted / trueBase);

    let low = lowPrime + (((highPrime % trueBase) * lowBase1) % trueBase) * lowBase2 % trueBase;
    if (low > trueBase) {
      ++high;
      low -= trueBase;
    }
    if ((low >>> 0) !== low || ((high >>> 0) !== high)) {
      return false;
    }
    this.low = low;
    this.high = high;
    return true;
  }

  parseString(s: string, base = 10) {
    if (!this.tryParseString(s, base)) {
      throw new Error(`Failed to parse string as uint64 value: ${JSON.stringify(s)}.`);
    }
    return this;
  }

  static parseString(s: string, base = 10) {
    let x = new Uint64();
    return x.parseString(s, base);
  }

  valid() {
    let {low, high} = this;
    return ((low >>> 0) === low) && ((high >>> 0) === high);
  }

  toJSON() { return this.toString(); }

  static encodeUint32Array (array: Uint64[]) : Uint32Array {
    const transferable = new Uint32Array(array.length * 2);

    for (let i = 0; i < array.length; i++) {
      const num = array[i];

      transferable[2 * i]      = num.low;
      transferable[2 * i + 1]  = num.high;
    }

    return transferable;
  }

  static decodeUint32Array (array: Uint32Array|ArrayBuffer) : Uint64[] {
    if (array instanceof ArrayBuffer) {
      array = new Uint32Array(array);
    }

    if (array.length % 2 === 1) {
      throw new Error(`Decode error. Length of input array was not even: ${array.length}`);
    }

    const decoded = new Array<Uint64>(array.length / 2);

    for (let i = 0; i < decoded.length; i++) {
      decoded[i] = new Uint64(
        array[2 * i],
        array[2 * i + 1],
      );
    }

    return decoded;
  }

};
