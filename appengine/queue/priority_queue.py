import heapq

class PriorityQueue(object):

    def __init__(self):
        self._pq = []

    def delete_index(self, i):
        self._pq[i] = self._pq[-1]
        self._pq.pop()
        if self._pq:
            heapq._siftup(self._pq, i)
            heapq._siftdown(self._pq, 0, i)

    def add_item(self, priority, item ):
        heapq.heappush(self._pq, (priority, item))

    def __iter__(self):
        return iter(self._pq)