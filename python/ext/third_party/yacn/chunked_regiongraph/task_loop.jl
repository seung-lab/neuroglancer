push!(LOAD_PATH, dirname(@__FILE__))
push!(LOAD_PATH, joinpath(dirname(@__FILE__),"../pre"))

include("tasks.jl")

using PyCall
@pyimport neuroglancer.simple_task_queue.task_queue as task_queue

tq = task_queue.TaskQueue("http://50.16.149.198:8000/1.0")

while true
	task = tq[:lease](60)
	println(task[:payload])
	eval(parse(task[:payload]))
	tq[:delete](task[:name])
end
