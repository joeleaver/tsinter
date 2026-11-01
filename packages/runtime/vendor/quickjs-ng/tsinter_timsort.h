/* V8's array sort, the one text both engines compile: a line-by-line transcription of third_party/v8/builtins/array-sort.tq (TimSort) and
 * src/builtins/typed-array-sort.tq (the comparator merge sort) from the V8 that
 * Node v24.18.1 ships (13.6.233.17-node.50). Sources, as downloaded from the
 * v24.18.1 tag (deps/v8/...):
 *   array-sort.tq        sha256 2ac3d8fc187e4f5096afb153d018390e2b250cde3e36badafe89da3faeebe55e
 *   typed-array-sort.tq  sha256 85562238e5b0e1f58fd900a388f2cd0a2068370a4c9859f9ff4abef277e1ccf1
 * Node exposes the exact sequence of comparator calls to user code, so the order of
 * every Compare below, and of its two operands, is part of the contract; the names
 * are Torque's so the two texts can be read side by side.
 *
 * What differs from the Torque, none of it visible to a comparator:
 *   - there is no SortState object. st is an int array holding minGallop (st[0]),
 *     pendingRunsSize (st[1]) and the pending-run stack (st[2]...); ctx is the
 *     comparator; both travel as parameters, so a comparator may sort reentrantly.
 *   - exceptions are the tier's pending flag, not unwinding: every Compare is
 *     followed by a test, and a function that saw one answers kFailure (the shape
 *     array-sort.tq itself had while it had a bailout path).
 *   - the temp array is allocated once, at length / 2 + 1 (the larger of a merge's
 *     two sides never reaches the temp; the smaller is at most half of everything),
 *     instead of being grown on demand, and only when a second run exists.
 *   - Copy is array.copy, which has memmove's overlap semantics, exactly what the
 *     Torque's direction test spells out.
 *   - the pre-processing step reads a classification (0 an element, 1 undefined,
 *     2 a hole) instead of comparing to TheHole / Undefined.
 *
 * Two compilers read this file, and it stays inside what both accept: the WasmGC
 * tier's C-subset compiler (backend/wasm/csubset.ts, through the generated
 * backend/wasm/timsort-src.ts), which supplies elem_t, ctx_t, sort_compare, sort_threw,
 * ea_new, ia_new, ea_copy and elem_class per instance (backend/wasm/sort.ts); and clang,
 * inside quickjs.c, whose local patch defines those as macros over JSValue
 * (TSINTER_QJS_SORT, vendor/README.md). */
static const int kSuccess = 0;
static const int kFailure = -1;
static const int kMaxMergePending = 85;
static const int kMinGallopWins = 7;
static const int kStMinGallop = 0;
static const int kStRunsSize = 1;
static const int kStRuns = 2;

#define RunBase(run) st[kStRuns + ((run) << 1)]
#define RunLength(run) st[kStRuns + ((run) << 1) + 1]
#define COMPARE(order, x, y) order = sort_compare(ctx, x, y); if (sort_threw()) return kFailure

static int PushRun(int* st, int runBase, int length) {
  int stackSize = st[kStRunsSize];
  RunBase(stackSize) = runBase;
  RunLength(stackSize) = length;
  st[kStRunsSize] = stackSize + 1;
  return kSuccess;
}

static int BinaryInsertionSort(ctx_t ctx, elem_t* workArray, int low, int startArg, int high) {
  int start = low == startArg ? (startArg + 1) : startArg;
  for (; start < high; ++start) {
    // Set left to where a[start] belongs.
    int left = low;
    int right = start;
    elem_t pivot = workArray[right];
    // Find pivot insertion point.
    while (left < right) {
      int mid = left + ((right - left) >> 1);
      double order;
      COMPARE(order, pivot, workArray[mid]);
      if (order < 0) {
        right = mid;
      } else {
        left = mid + 1;
      }
    }
    // pivot belongs at left. Slide over to make room.
    ea_copy(workArray, left + 1, workArray, left, start - left);
    workArray[left] = pivot;
  }
  return kSuccess;
}

static int ReverseRange(elem_t* array, int from, int to) {
  int low = from;
  int high = to - 1;
  while (low < high) {
    elem_t elementLow = array[low];
    elem_t elementHigh = array[high];
    array[low++] = elementHigh;
    array[high--] = elementLow;
  }
  return kSuccess;
}

// The length of the run beginning at lowArg, in [lowArg, high); a strictly
// descending run is reversed in place. kFailure if a comparison threw.
static int CountAndMakeRun(ctx_t ctx, elem_t* workArray, int lowArg, int high) {
  int low = lowArg + 1;
  if (low == high) return 1;

  int runLength = 2;

  elem_t elementLow = workArray[low];
  elem_t elementLowPred = workArray[low - 1];
  double order;
  COMPARE(order, elementLow, elementLowPred);

  int isDescending = order < 0 ? 1 : 0;

  elem_t previousElement = elementLow;
  for (int idx = low + 1; idx < high; ++idx) {
    elem_t currentElement = workArray[idx];
    COMPARE(order, currentElement, previousElement);

    if (isDescending) {
      if (!(order < 0)) break;
    } else {
      if (order < 0) break;
    }

    previousElement = currentElement;
    ++runLength;
  }

  if (isDescending) {
    ReverseRange(workArray, lowArg, lowArg + runLength);
  }

  return runLength;
}

static int GallopLeft(ctx_t ctx, elem_t* array, elem_t key, int runBase, int length, int hint) {
  int lastOfs = 0;
  int offset = 1;

  elem_t baseHintElement = array[runBase + hint];
  double order;
  COMPARE(order, baseHintElement, key);

  if (order < 0) {
    // a[base + hint] < key: gallop right, until
    // a[base + hint + lastOfs] < key <= a[base + hint + offset].

    // a[base + length - 1] is highest.
    int maxOfs = length - hint;
    while (offset < maxOfs) {
      elem_t offsetElement = array[runBase + hint + offset];
      COMPARE(order, offsetElement, key);

      // a[base + hint + offset] >= key? Break.
      if (!(order < 0)) break;

      lastOfs = offset;
      offset = (offset << 1) + 1;

      // Integer overflow.
      if (offset <= 0) offset = maxOfs;
    }

    if (offset > maxOfs) offset = maxOfs;

    // Translate back to positive offsets relative to runBase.
    lastOfs = lastOfs + hint;
    offset = offset + hint;
  } else {
    // key <= a[base + hint]: gallop left, until
    // a[base + hint - offset] < key <= a[base + hint - lastOfs].

    // a[base + hint] is lowest.
    int maxOfs = hint + 1;
    while (offset < maxOfs) {
      elem_t offsetElement = array[runBase + hint - offset];
      COMPARE(order, offsetElement, key);

      if (order < 0) break;

      lastOfs = offset;
      offset = (offset << 1) + 1;

      // Integer overflow.
      if (offset <= 0) offset = maxOfs;
    }

    if (offset > maxOfs) offset = maxOfs;

    // Translate back to positive offsets relative to runBase.
    int tmp = lastOfs;
    lastOfs = hint - offset;
    offset = hint - tmp;
  }

  // Now a[base+lastOfs] < key <= a[base+offset], so key belongs
  // somewhere to the right of lastOfs but no farther right than offset.
  // Do a binary search, with invariant:
  //   a[base + lastOfs - 1] < key <= a[base + offset].
  lastOfs++;
  while (lastOfs < offset) {
    int m = lastOfs + ((offset - lastOfs) >> 1);

    COMPARE(order, array[runBase + m], key);

    if (order < 0) {
      lastOfs = m + 1;  // a[base + m] < key.
    } else {
      offset = m;  // key <= a[base + m].
    }
  }
  // so a[base + offset - 1] < key <= a[base + offset].
  return offset;
}

// Exactly like GallopLeft, except that if key already exists in
// [runBase, runBase + length), finds the position immediately to the right of
// the rightmost equal value.
static int GallopRight(ctx_t ctx, elem_t* array, elem_t key, int runBase, int length, int hint) {
  int lastOfs = 0;
  int offset = 1;

  elem_t baseHintElement = array[runBase + hint];
  double order;
  COMPARE(order, key, baseHintElement);

  if (order < 0) {
    // key < a[base + hint]: gallop left, until
    // a[base + hint - offset] <= key < a[base + hint - lastOfs].

    // a[base + hint] is lowest.
    int maxOfs = hint + 1;
    while (offset < maxOfs) {
      elem_t offsetElement = array[runBase + hint - offset];
      COMPARE(order, key, offsetElement);

      if (!(order < 0)) break;

      lastOfs = offset;
      offset = (offset << 1) + 1;

      // Integer overflow.
      if (offset <= 0) offset = maxOfs;
    }

    if (offset > maxOfs) offset = maxOfs;

    // Translate back to positive offsets relative to runBase.
    int tmp = lastOfs;
    lastOfs = hint - offset;
    offset = hint - tmp;
  } else {
    // a[base + hint] <= key: gallop right, until
    // a[base + hint + lastOfs] <= key < a[base + hint + offset].

    // a[base + length - 1] is highest.
    int maxOfs = length - hint;
    while (offset < maxOfs) {
      elem_t offsetElement = array[runBase + hint + offset];
      COMPARE(order, key, offsetElement);

      // a[base + hint + ofs] <= key.
      if (order < 0) break;

      lastOfs = offset;
      offset = (offset << 1) + 1;

      // Integer overflow.
      if (offset <= 0) offset = maxOfs;
    }

    if (offset > maxOfs) offset = maxOfs;

    // Translate back to positive offests relative to runBase.
    lastOfs = lastOfs + hint;
    offset = offset + hint;
  }

  // Now a[base + lastOfs] <= key < a[base + ofs], so key belongs
  // somewhere to the right of lastOfs but no farther right than ofs.
  // Do a binary search, with invariant
  // a[base + lastOfs - 1] < key <= a[base + ofs].
  lastOfs++;
  while (lastOfs < offset) {
    int m = lastOfs + ((offset - lastOfs) >> 1);

    COMPARE(order, key, array[runBase + m]);

    if (order < 0) {
      offset = m;  // key < a[base + m].
    } else {
      lastOfs = m + 1;  // a[base + m] <= key.
    }
  }
  // so a[base + offset - 1] <= key < a[base + offset].
  return offset;
}

// Merge the lengthA elements starting at baseA with the lengthB elements
// starting at baseB in a stable way, in-place.
static int MergeLow(ctx_t ctx, elem_t* workArray, int* st, elem_t* tempArray, int baseA, int lengthA, int baseB, int lengthB) {
  ea_copy(tempArray, 0, workArray, baseA, lengthA);

  int dest = baseA;
  int cursorTemp = 0;
  int cursorB = baseB;

  workArray[dest++] = workArray[cursorB++];

  if (--lengthB == 0) goto Succeed;
  if (lengthA == 1) goto CopyB;

  int minGallop = st[kStMinGallop];
  for (;;) {
    int nofWinsA = 0;  // # of times A won in a row.
    int nofWinsB = 0;  // # of times B won in a row.

    // Do the straightforward thing until (if ever) one run appears to
    // win consistently.
    for (;;) {
      double order;
      COMPARE(order, workArray[cursorB], tempArray[cursorTemp]);

      if (order < 0) {
        workArray[dest++] = workArray[cursorB++];

        ++nofWinsB;
        --lengthB;
        nofWinsA = 0;

        if (lengthB == 0) goto Succeed;
        if (nofWinsB >= minGallop) break;
      } else {
        workArray[dest++] = tempArray[cursorTemp++];

        ++nofWinsA;
        --lengthA;
        nofWinsB = 0;

        if (lengthA == 1) goto CopyB;
        if (nofWinsA >= minGallop) break;
      }
    }

    // One run is winning so consistently that galloping may be a huge
    // win. So try that, and continue galloping until (if ever) neither
    // run appears to be winning consistently anymore.
    ++minGallop;
    int firstIteration = 1;
    while (nofWinsA >= kMinGallopWins || nofWinsB >= kMinGallopWins || firstIteration) {
      firstIteration = 0;

      minGallop = minGallop - 1 > 1 ? minGallop - 1 : 1;
      st[kStMinGallop] = minGallop;

      nofWinsA = GallopRight(ctx, tempArray, workArray[cursorB], cursorTemp, lengthA, 0);
      if (nofWinsA < 0) return kFailure;

      if (nofWinsA > 0) {
        ea_copy(workArray, dest, tempArray, cursorTemp, nofWinsA);
        dest = dest + nofWinsA;
        cursorTemp = cursorTemp + nofWinsA;
        lengthA = lengthA - nofWinsA;

        if (lengthA == 1) goto CopyB;

        // lengthA == 0 is impossible now if the comparison function is
        // consistent, but we can't assume that it is.
        if (lengthA == 0) goto Succeed;
      }
      workArray[dest++] = workArray[cursorB++];
      if (--lengthB == 0) goto Succeed;

      nofWinsB = GallopLeft(ctx, workArray, tempArray[cursorTemp], cursorB, lengthB, 0);
      if (nofWinsB < 0) return kFailure;
      if (nofWinsB > 0) {
        ea_copy(workArray, dest, workArray, cursorB, nofWinsB);

        dest = dest + nofWinsB;
        cursorB = cursorB + nofWinsB;
        lengthB = lengthB - nofWinsB;

        if (lengthB == 0) goto Succeed;
      }
      workArray[dest++] = tempArray[cursorTemp++];
      if (--lengthA == 1) goto CopyB;
    }
    ++minGallop;  // Penalize it for leaving galloping mode
    st[kStMinGallop] = minGallop;
  }

Succeed:
  if (lengthA > 0) {
    ea_copy(workArray, dest, tempArray, cursorTemp, lengthA);
  }
  return kSuccess;

CopyB:
  // The last element of run A belongs at the end of the merge.
  ea_copy(workArray, dest, workArray, cursorB, lengthB);
  workArray[dest + lengthB] = tempArray[cursorTemp];
  return kSuccess;
}

// Merge the lengthA elements starting at baseA with the lengthB elements
// starting at baseB in a stable way, in-place.
static int MergeHigh(ctx_t ctx, elem_t* workArray, int* st, elem_t* tempArray, int baseA, int lengthA, int baseB, int lengthB) {
  ea_copy(tempArray, 0, workArray, baseB, lengthB);

  // MergeHigh merges the two runs backwards.
  int dest = baseB + lengthB - 1;
  int cursorTemp = lengthB - 1;
  int cursorA = baseA + lengthA - 1;

  workArray[dest--] = workArray[cursorA--];

  if (--lengthA == 0) goto Succeed;
  if (lengthB == 1) goto CopyA;

  int minGallop = st[kStMinGallop];
  for (;;) {
    int nofWinsA = 0;  // # of times A won in a row.
    int nofWinsB = 0;  // # of times B won in a row.

    // Do the straightforward thing until (if ever) one run appears to
    // win consistently.
    for (;;) {
      double order;
      COMPARE(order, tempArray[cursorTemp], workArray[cursorA]);

      if (order < 0) {
        workArray[dest--] = workArray[cursorA--];

        ++nofWinsA;
        --lengthA;
        nofWinsB = 0;

        if (lengthA == 0) goto Succeed;
        if (nofWinsA >= minGallop) break;
      } else {
        workArray[dest--] = tempArray[cursorTemp--];

        ++nofWinsB;
        --lengthB;
        nofWinsA = 0;

        if (lengthB == 1) goto CopyA;
        if (nofWinsB >= minGallop) break;
      }
    }

    // One run is winning so consistently that galloping may be a huge
    // win. So try that, and continue galloping until (if ever) neither
    // run appears to be winning consistently anymore.
    ++minGallop;
    int firstIteration = 1;
    while (nofWinsA >= kMinGallopWins || nofWinsB >= kMinGallopWins || firstIteration) {
      firstIteration = 0;

      minGallop = minGallop - 1 > 1 ? minGallop - 1 : 1;
      st[kStMinGallop] = minGallop;

      int k = GallopRight(ctx, workArray, tempArray[cursorTemp], baseA, lengthA, lengthA - 1);
      if (k < 0) return kFailure;
      nofWinsA = lengthA - k;

      if (nofWinsA > 0) {
        dest = dest - nofWinsA;
        cursorA = cursorA - nofWinsA;
        ea_copy(workArray, dest + 1, workArray, cursorA + 1, nofWinsA);

        lengthA = lengthA - nofWinsA;
        if (lengthA == 0) goto Succeed;
      }
      workArray[dest--] = tempArray[cursorTemp--];
      if (--lengthB == 1) goto CopyA;

      k = GallopLeft(ctx, tempArray, workArray[cursorA], 0, lengthB, lengthB - 1);
      if (k < 0) return kFailure;
      nofWinsB = lengthB - k;

      if (nofWinsB > 0) {
        dest = dest - nofWinsB;
        cursorTemp = cursorTemp - nofWinsB;
        ea_copy(workArray, dest + 1, tempArray, cursorTemp + 1, nofWinsB);

        lengthB = lengthB - nofWinsB;
        if (lengthB == 1) goto CopyA;

        // lengthB == 0 is impossible now if the comparison function is
        // consistent, but we can't assume that it is.
        if (lengthB == 0) goto Succeed;
      }
      workArray[dest--] = workArray[cursorA--];
      if (--lengthA == 0) goto Succeed;
    }
    ++minGallop;
    st[kStMinGallop] = minGallop;
  }

Succeed:
  if (lengthB > 0) {
    ea_copy(workArray, dest - (lengthB - 1), tempArray, 0, lengthB);
  }
  return kSuccess;

CopyA:
  // The first element of run B belongs at the front of the merge.
  dest = dest - lengthA;
  cursorA = cursorA - lengthA;
  ea_copy(workArray, dest + 1, workArray, cursorA + 1, lengthA);
  workArray[dest] = tempArray[cursorTemp];
  return kSuccess;
}

// Merges the two runs at stack indices i and i + 1.
static int MergeAt(ctx_t ctx, elem_t* workArray, int* st, elem_t* tempArray, int i) {
  int stackSize = st[kStRunsSize];

  int baseA = RunBase(i);
  int lengthA = RunLength(i);
  int baseB = RunBase(i + 1);
  int lengthB = RunLength(i + 1);

  // Record the length of the combined runs; if i is the 3rd-last run now,
  // also slide over the last run (which isn't involved in this merge).
  // The current run i + 1 goes away in any case.
  RunLength(i) = lengthA + lengthB;
  if (i == stackSize - 3) {
    int runBase = RunBase(i + 2);
    int length = RunLength(i + 2);
    RunBase(i + 1) = runBase;
    RunLength(i + 1) = length;
  }
  st[kStRunsSize] = stackSize - 1;

  // Where does b start in a? Elements in a before that can be ignored,
  // because they are already in place.
  elem_t keyRight = workArray[baseB];
  int k = GallopRight(ctx, workArray, keyRight, baseA, lengthA, 0);
  if (k < 0) return kFailure;

  baseA = baseA + k;
  lengthA = lengthA - k;
  if (lengthA == 0) return kSuccess;

  // Where does a end in b? Elements in b after that can be ignored,
  // because they are already in place.
  elem_t keyLeft = workArray[baseA + lengthA - 1];
  lengthB = GallopLeft(ctx, workArray, keyLeft, baseB, lengthB, lengthB - 1);
  if (lengthB < 0) return kFailure;
  if (lengthB == 0) return kSuccess;

  // Merge what remains of the runs, using a temp array with
  // min(lengthA, lengthB) elements.
  if (lengthA <= lengthB) {
    return MergeLow(ctx, workArray, st, tempArray, baseA, lengthA, baseB, lengthB);
  }
  return MergeHigh(ctx, workArray, st, tempArray, baseA, lengthA, baseB, lengthB);
}

static int ComputeMinRunLength(int nArg) {
  int n = nArg;
  int r = 0;  // Becomes 1 if any 1 bits are shifted off.

  while (n >= 64) {
    r = r | (n & 1);
    n = n >> 1;
  }

  return n + r;
}

// Returns true iff run_length(n - 2) > run_length(n - 1) + run_length(n).
static int RunInvariantEstablished(int* st, int n) {
  if (n < 2) return 1;

  int runLengthN = RunLength(n);
  int runLengthNM = RunLength(n - 1);
  int runLengthNMM = RunLength(n - 2);

  return runLengthNMM > runLengthNM + runLengthN;
}

// Examines the stack of runs waiting to be merged, merging adjacent runs
// until the stack invariants are re-established.
static int MergeCollapse(ctx_t ctx, elem_t* workArray, int* st, elem_t* tempArray) {
  // Reload the stack size because MergeAt might change it.
  while (st[kStRunsSize] > 1) {
    int n = st[kStRunsSize] - 2;

    if (!RunInvariantEstablished(st, n + 1) || !RunInvariantEstablished(st, n)) {
      if (RunLength(n - 1) < RunLength(n + 1)) {
        --n;
      }

      if (MergeAt(ctx, workArray, st, tempArray, n) < 0) return kFailure;
    } else if (RunLength(n) <= RunLength(n + 1)) {
      if (MergeAt(ctx, workArray, st, tempArray, n) < 0) return kFailure;
    } else {
      break;
    }
  }
  return kSuccess;
}

// Regardless of invariants, merge all runs on the stack until only one
// remains. This is used at the end of the mergesort.
static int MergeForceCollapse(ctx_t ctx, elem_t* workArray, int* st, elem_t* tempArray) {
  // Reload the stack size becuase MergeAt might change it.
  while (st[kStRunsSize] > 1) {
    int n = st[kStRunsSize] - 2;

    if (n > 0 && RunLength(n - 1) < RunLength(n + 1)) {
      --n;
    }
    if (MergeAt(ctx, workArray, st, tempArray, n) < 0) return kFailure;
  }
  return kSuccess;
}

static int ArrayTimSortImpl(ctx_t ctx, elem_t* workArray, int length) {
  if (length < 2) return kSuccess;
  int remaining = length;

  int* st = ia_new(kStRuns + 2 * kMaxMergePending);
  st[kStMinGallop] = kMinGallopWins;
  elem_t* tempArray;

  // March over the array once, left to right, finding natural runs,
  // and extending short natural runs to minrun elements.
  int low = 0;
  int minRunLength = ComputeMinRunLength(remaining);
  while (remaining != 0) {
    int currentRunLength = CountAndMakeRun(ctx, workArray, low, low + remaining);
    if (currentRunLength < 0) return kFailure;

    // If the run is short, extend it to min(minRunLength, remaining).
    if (currentRunLength < minRunLength) {
      int forcedRunLength = minRunLength < remaining ? minRunLength : remaining;
      if (BinaryInsertionSort(ctx, workArray, low, low + currentRunLength, low + forcedRunLength) < 0) return kFailure;
      currentRunLength = forcedRunLength;
    }

    // The first run does not cover everything: merges are coming.
    if (low == 0 && currentRunLength < remaining) tempArray = ea_new((length >> 1) + 1);

    // Push run onto pending-runs stack, and maybe merge.
    PushRun(st, low, currentRunLength);

    if (MergeCollapse(ctx, workArray, st, tempArray) < 0) return kFailure;

    // Advance to find next run.
    low = low + currentRunLength;
    remaining = remaining - currentRunLength;
  }

  return MergeForceCollapse(ctx, workArray, st, tempArray);
}

#if !defined(TSINTER_QJS_SORT)
// CompactReceiverElementsIntoWorkArray, then the sort: the elements of
// src[0..n) that are neither undefined nor holes, sorted into workArray.
// Answers their count (kFailure if a comparison threw); counts[0] is the
// number of undefineds and counts[1] of holes. Nothing here writes to src.
static int ArrayTimSort(ctx_t ctx, elem_t* src, int n, elem_t* workArray, int* counts) {
  int numberOfNonUndefined = 0;
  for (int i = 0; i < n; ++i) {
    elem_t element = src[i];
    int cls = elem_class(element);
    if (cls == 0) {
      workArray[numberOfNonUndefined++] = element;
    } else if (cls == 1) {
      counts[0] = counts[0] + 1;
    } else {
      counts[1] = counts[1] + 1;
    }
  }
  if (ArrayTimSortImpl(ctx, workArray, numberOfNonUndefined) < 0) return kFailure;
  return numberOfNonUndefined;
}
#endif

// typed-array-sort.tq: merges the sorted runs [from, middle) and [middle, to)
// from source into target.
static int TypedArrayMerge(ctx_t ctx, elem_t* source, int from, int middle, int to, elem_t* target) {
  int left = from;
  int right = middle;

  for (int targetIndex = from; targetIndex < to; ++targetIndex) {
    if (left < middle && right >= to) {
      // If the left run has elements, but the right does not, we take
      // from the left.
      target[targetIndex] = source[left++];
    } else if (left < middle) {
      // If both have elements, we need to compare.
      elem_t leftElement = source[left];
      elem_t rightElement = source[right];
      double order;
      COMPARE(order, leftElement, rightElement);
      if (!(order > 0)) {
        target[targetIndex] = leftElement;
        left++;
      } else {
        target[targetIndex] = rightElement;
        right++;
      }
    } else {
      // No elements on the left, but the right does, so we take
      // from the right.
      target[targetIndex] = source[right++];
    }
  }
  return kSuccess;
}

static int TypedArrayMergeSort(ctx_t ctx, elem_t* source, int from, int to, elem_t* target) {
  int middle = from + ((to - from) >> 1);

  // On the next recursion step source becomes target and vice versa.
  if (middle - from > 1) {
    if (TypedArrayMergeSort(ctx, target, from, middle, source) < 0) return kFailure;
  }
  if (to - middle > 1) {
    if (TypedArrayMergeSort(ctx, target, middle, to, source) < 0) return kFailure;
  }

  return TypedArrayMerge(ctx, source, from, middle, to, target);
}

#if !defined(TSINTER_QJS_SORT)
// SmiLexicographicCompare's answer: the order of the two integers' decimal
// spellings, without spelling them (a default sort's fast path). Both are
// below 2^30 in magnitude.
static int NumberOfDigits(uint64_t x) {
  int digits = 1;
  while (x >= 10) {
    x = x / 10;
    ++digits;
  }
  return digits;
}

static int SmiLexicographicCompare(int x, int y) {
  if (x == y) return 0;
  // The minus sign sorts below every digit; two minus signs cancel out.
  if (x < 0 && y >= 0) return -1;
  if (x >= 0 && y < 0) return 1;
  uint64_t ux = static_cast<uint64_t>(x < 0 ? -x : x);
  uint64_t uy = static_cast<uint64_t>(y < 0 ? -y : y);
  int dx = NumberOfDigits(ux);
  int dy = NumberOfDigits(uy);
  for (int i = dx; i < dy; ++i) ux = ux * 10;
  for (int i = dy; i < dx; ++i) uy = uy * 10;
  if (ux == uy) return dx < dy ? -1 : 1;
  return ux < uy ? -1 : 1;
}
#endif
