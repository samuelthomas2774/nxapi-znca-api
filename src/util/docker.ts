import { Agent } from 'node:http';
import fetch from 'node-fetch';
import { ErrorResponse } from 'nxapi';

export interface DockerListContainersFilters {
    ancestor: string[];
    before: string[];
    expose: string[];
    exited: string[];
    health: string[];
    id: string[];
    isolation: string[];
    is: string[];
    label: string[];
    name: string[];
    network: string[];
    publish: string[];
    since: string[];
    status: string[];
    volume: string[];
}

export interface DockerListContainersItem {
    Id: string;
    Names: string[];
    Image: string;
    ImageID: string;
    Command: string;
    Created: number;
    State: string;
    Status: string;
    Ports: DockerContainerPort[];
    Labels: Record<string, string>;
    SizeRw?: number;
    SizeRootFs?: number;
    HostConfig: {
        NetworkMode: string;
    };
    NetworkSettings: {
        Networks: Record<string, DockerContainerNetwork>;
    };
    Mounts: DockerContainerMount[];
}
interface DockerContainerPort {
    PrivatePort: number;
    PublicPort: number;
    Type: string;
}
interface DockerContainerNetwork {
    NetworkID: string;
    EndpointID: string;
    Gateway: string;
    IPAddress: string;
    IPPrefixLen: number;
    IPv6Gateway: string;
    GlobalIPv6Address: string;
    GlobalIPv6PrefixLen: number;
    MacAddress: string;
}
interface DockerContainerMount {
    Name: string;
    Source: string;
    Destination: string;
    Driver: string;
    Mode: string;
    RW: boolean;
    Propagation: string;
}

const agent = new Agent({
    // @ts-expect-error
    socketPath: '/var/run/docker.sock',
});

export async function listDockerContainers(filters?: Partial<DockerListContainersFilters>) {
    const response = await fetch('http://docker/v1.41/containers/json?' + new URLSearchParams({
        filters: JSON.stringify(filters ?? {}),
    }).toString(), {
        agent,
    });

    if (response.status !== 200) {
        throw new ErrorResponse('Non-200 status code from Docker API', response, await response.text());
    }

    const data = await response.json() as DockerListContainersItem[];
    return data;
}
