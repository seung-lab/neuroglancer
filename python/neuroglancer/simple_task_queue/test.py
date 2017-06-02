from task_queue import TaskQueue

tq=TaskQueue('http://localhost:8888/1.0')
tq.insert("0","task0")
tq.insert("1","task1")
tq.insert("2","task2",dependencies=["task1","task0"])

t1=tq.lease(lease_time=100)
t2=tq.lease(lease_time=100)

print t1
print t2
try:
	t3=tq.lease(lease_time=100)
	print t3
except Exception as e:
	print e

tq.delete("task0")

try:
	t3=tq.lease(lease_time=100)
	print t3
except Exception as e:
	print e

tq.delete("task1")

try:
	t3=tq.lease(lease_time=100)
	print t3
except Exception as e:
	print e
